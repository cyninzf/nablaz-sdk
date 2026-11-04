// Phase-2 operational rows over the RPC legs, against stub JSON-RPC servers on 127.0.0.1:
//   Row C: each of the four legs answers at boot (eth_chainId equal to the chain's, eth_blockNumber); a failure
//          names the leg's variable and host, never the URL's path or key.
//   Row D: an RPC error carries its leg and chain in its message (R-S194-10: indexer vs grounding in the logs).
//   Row E: per chain and leg, request / error / rate-limited counters and the rate-limit state, in Prometheus text
//          (served by the reader on loopback at /metrics/reader).

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHAINS, enabledChains } from "../../src/chains";
import { groundingClient, indexerTransport, resetRpcCounters, rpcMetricsText } from "../../src/rpc";
import { checkRpcLegs } from "../../src/rpc-check";

type Mode = "ok" | "down" | "limited" | "wrongChain" | "rpcError";
type Stub = { url: string; mode: Mode; chainId: number; server: Server };

async function stub(chainId: number): Promise<Stub> {
  const s: Stub = { url: "", mode: "ok", chainId, server: undefined as never };
  s.server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const { id, method } = JSON.parse(body) as { id: number; method: string };
    if (s.mode === "down") return res.writeHead(503).end("down");
    if (s.mode === "limited") return res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: 429, message: "Too Many Requests" } }));
    if (s.mode === "rpcError") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "upstream exploded" } }));
    const cid = s.mode === "wrongChain" ? 1 : s.chainId;
    const result = method === "eth_chainId" ? `0x${cid.toString(16)}` : method === "eth_blockNumber" ? "0x10" : method === "eth_getLogs" ? [] : "0x";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`;
  return s;
}

const KEY = "FAKEKEYabc123";
let arbIdx: Stub, arbGnd: Stub, baseIdx: Stub, baseGnd: Stub;
beforeAll(async () => {
  [arbIdx, arbGnd, baseIdx, baseGnd] = [await stub(42161), await stub(42161), await stub(8453), await stub(8453)];
});
afterAll(() => {
  for (const s of [arbIdx, arbGnd, baseIdx, baseGnd]) s.server.close();
});
beforeEach(() => {
  for (const s of [arbIdx, arbGnd, baseIdx, baseGnd]) s.mode = "ok";
  resetRpcCounters();
});

/** The four legs' variables, each URL with a key-shaped path that must never be printed. */
const env = () => ({
  READER_ARBITRUM_RPC_URL: `${arbIdx.url}/${KEY}`,
  READER_ARBITRUM_GROUNDING_RPC_URL: `${arbGnd.url}/v2/${KEY}`,
  READER_BASE_RPC_URL: `${baseIdx.url}/${KEY}`,
  READER_BASE_GROUNDING_RPC_URL: `${baseGnd.url}/v2/${KEY}`,
});
const chains = () => enabledChains(CHAINS, "42161,8453");

describe("row C: startup RPC check", () => {
  it("all four legs answer: four ok results, one per variable, with host and head", async () => {
    const r = await checkRpcLegs(chains(), env());
    // enabledChains order (by chain id: Base, then Arbitrum), indexer before grounding.
    expect(r.map((x) => [x.env, x.ok])).toEqual([
      ["READER_BASE_RPC_URL", true],
      ["READER_BASE_GROUNDING_RPC_URL", true],
      ["READER_ARBITRUM_RPC_URL", true],
      ["READER_ARBITRUM_GROUNDING_RPC_URL", true],
    ]);
    expect(r.every((x) => x.head === 16n)).toBe(true);
    expect(r[0]!.host).toBe(new URL(baseIdx.url).host);
  });

  it("a leg down, one on the wrong chain, one unset: each failure names its variable and host, never the key", async () => {
    arbGnd.mode = "down";
    baseIdx.mode = "wrongChain";
    const e = { ...env(), READER_BASE_GROUNDING_RPC_URL: "" };
    const r = await checkRpcLegs(chains(), e);
    const bad = r.filter((x) => !x.ok);
    expect(bad.map((x) => x.env)).toEqual(["READER_BASE_RPC_URL", "READER_BASE_GROUNDING_RPC_URL", "READER_ARBITRUM_GROUNDING_RPC_URL"]);
    expect(bad[0]!.detail).toBe("eth_chainId is 1, expected 8453");
    expect(bad[1]!.detail).toBe("is not set");
    expect(bad[2]!.detail).toMatch(/HTTP 503/);
    const printed = JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain("/v2/");
  });
});

/** The transport called the way Ponder calls a custom rpc: chain.rpc({ chain, retryCount: 0, timeout: 10_000 }).request. */
const asPonder = (t: ReturnType<typeof indexerTransport>) => t({ chain: undefined, retryCount: 0, timeout: 10_000 }).request as (a: { method: string; params?: unknown }) => Promise<unknown>;

describe("row D: leg tagging", () => {
  const legs = () => asPonder(indexerTransport({ indexer: arbIdx.url, grounding: arbGnd.url }, {}, "arbitrum"));

  it("an error from the grounding leg (backfill) says grounding and the chain", async () => {
    arbGnd.mode = "rpcError";
    const err = (await legs()({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2" }] }).catch((e: unknown) => e)) as Error & { shortMessage?: string };
    expect(err.message.startsWith("[rpc arbitrum grounding] ")).toBe(true);
    expect(err.shortMessage!.startsWith("[rpc arbitrum grounding] ")).toBe(true);
  });

  it("an error from the indexer leg says indexer and is counted; once both fail, the surfaced error is the grounding leg's", async () => {
    arbIdx.mode = "rpcError";
    const req = legs();
    // The indexer leg fails; fallback goes on to the grounding leg, which answers.
    expect(await req({ method: "eth_blockNumber" })).toBe("0x10");
    expect(rpcMetricsText()).toMatch(/nablaz_rpc_errors_total\{chain="arbitrum",leg="indexer"\} 1/);
    arbGnd.mode = "rpcError";
    const err = (await req({ method: "eth_blockNumber" }).catch((e: unknown) => e)) as Error;
    expect(err.message.startsWith("[rpc arbitrum grounding] ")).toBe(true);
  });

  it("the grounding client tags its errors with its chain", async () => {
    baseGnd.mode = "rpcError";
    const g = groundingClient(CHAINS[8453]!, { READER_BASE_GROUNDING_RPC_URL: baseGnd.url });
    const err = (await g.request({ method: "eth_blockNumber" }).catch((e: unknown) => e)) as Error & { cause?: Error };
    // A viem client wraps the transport's error; the tagged one is its cause.
    expect([err.message, err.cause?.message].some((m) => m?.startsWith("[rpc base grounding] "))).toBe(true);
  });
});

describe("row E: counters in /metrics/reader", () => {
  it("counts requests, errors and 429s per chain and leg, with the rate-limit state", async () => {
    const req = asPonder(indexerTransport({ indexer: baseIdx.url, grounding: baseGnd.url }, {}, "base"));
    await req({ method: "eth_blockNumber" });
    await req({ method: "eth_blockNumber" });
    baseGnd.mode = "limited";
    await req({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2" }] }).catch(() => {});
    const t = rpcMetricsText();
    expect(t).toMatch(/^# TYPE nablaz_rpc_requests_total counter$/m);
    expect(t).toMatch(/^nablaz_rpc_requests_total\{chain="base",leg="indexer"\} 2$/m);
    expect(t).toMatch(/^nablaz_rpc_errors_total\{chain="base",leg="indexer"\} 0$/m);
    expect(t).toMatch(/^nablaz_rpc_rate_limited_total\{chain="base",leg="grounding"\} 1$/m);
    expect(t).toMatch(/^nablaz_rpc_rate_limited_recent\{chain="base",leg="grounding"\} 1$/m);
    expect(t).toMatch(/^nablaz_rpc_rate_limited_recent\{chain="base",leg="indexer"\} 0$/m);
    expect(t).toMatch(/^nablaz_rpc_last_rate_limited_timestamp_seconds\{chain="base",leg="grounding"\} \d{10}$/m);
    expect(t).not.toContain("127.0.0.1");
  });
});
