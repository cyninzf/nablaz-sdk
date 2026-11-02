// RPC roles (R-S192-8, R-S192-4 AMENDED), against two stub JSON-RPC servers on 127.0.0.1 that record every call
// they receive. Counts are taken at the servers, not read from the config.
//   Normal operation: no head-tracking call reaches the grounding (Alchemy) URL; range eth_getLogs reach it only.
//   Indexer (Chainstack) URL down: head-tracking calls continue through the grounding URL.
//   The Chainstack leg never sends a range eth_getLogs over CHAINSTACK_LOGS_RANGE blocks.
//   The grounding client sends nothing to the indexer URL.
//   Every leg, and the grounding client, takes a response the size of the largest observed Base block (R-S197-7).
//   An RPC error surfaced from any leg carries neither a transport URL nor the key in it (R-S197-8).

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublicClient, custom, http, ResponseBodyTooLargeError, RpcRequestError, type PublicClient } from "viem";
import { CHAINS } from "../../src/chains";
import { CHAINSTACK_LOGS_RANGE, READER_MAX_RESPONSE_BYTES, cappedLogs, groundingClient, indexerTransport, rpcUrls } from "../../src/rpc";

/** Largest observed Base full-transaction block body: block 51,354,171 (S197 measurement). */
const LARGEST_BASE_BLOCK_BYTES = 10_502_144;

type Stub = { url: string; calls: string[]; down: boolean; fat: boolean; served: number[]; server: Server };

/** A JSON-RPC response of exactly LARGEST_BASE_BLOCK_BYTES bytes, and its result. */
function fat(id: number): { body: string; result: string } {
  const envelope = JSON.stringify({ jsonrpc: "2.0", id, result: "0x" });
  const result = `0x${"0".repeat(LARGEST_BASE_BLOCK_BYTES - envelope.length)}`;
  return { body: JSON.stringify({ jsonrpc: "2.0", id, result }), result };
}

async function stub(): Promise<Stub> {
  const s: Stub = { url: "", calls: [], down: false, fat: false, served: [], server: undefined as never };
  s.server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const { id, method } = JSON.parse(body) as { id: number; method: string };
    s.calls.push(method);
    if (s.down) return res.writeHead(503).end("down");
    if (s.fat) {
      const f = fat(id);
      s.served.push(f.result.length);
      return res.writeHead(200, { "content-type": "application/json" }).end(f.body);
    }
    const result = method === "eth_getLogs" ? [] : method === "eth_chainId" ? "0x2105" : method === "eth_blockNumber" ? "0x10" : "0x";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`;
  return s;
}

let chainstack: Stub;
let alchemy: Stub;
beforeAll(async () => {
  [chainstack, alchemy] = [await stub(), await stub()];
});
afterAll(() => {
  chainstack.server.close();
  alchemy.server.close();
});
beforeEach(() => {
  for (const s of [chainstack, alchemy]) {
    s.calls.length = 0;
    s.down = false;
    s.fat = false;
    s.served.length = 0;
  }
});

const client = () => createPublicClient({ transport: indexerTransport({ indexer: chainstack.url, grounding: alchemy.url }) }) as PublicClient;
const hex = (n: number) => `0x${n.toString(16)}`;
const HASH = `0x${"11".repeat(32)}`;

/** The calls Ponder's realtime sync makes per new block, plus a state read (src/api/index.ts). */
async function headTracking(c: PublicClient) {
  await c.request({ method: "eth_chainId" });
  await c.request({ method: "eth_blockNumber" });
  await c.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
  await c.request({ method: "eth_getBlockByHash", params: [HASH as never, true] });
  await c.request({ method: "eth_getLogs", params: [{ blockHash: HASH } as never] });
  await c.request({ method: "eth_getTransactionReceipt", params: [HASH as never] });
  await c.request({ method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "0x10"] as never });
}

describe("indexer transport", () => {
  it("normal operation: every head-tracking call reaches the indexer URL, none the grounding URL", async () => {
    await headTracking(client());
    expect(chainstack.calls).toEqual(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs", "eth_getTransactionReceipt", "eth_call"]);
    expect(alchemy.calls).toEqual([]);
  });

  it("a range eth_getLogs (backfill) reaches the grounding URL only, at any range", async () => {
    await client().request({ method: "eth_getLogs", params: [{ fromBlock: hex(1), toBlock: hex(5_000_000) } as never] });
    expect(alchemy.calls).toEqual(["eth_getLogs"]);
    expect(chainstack.calls).toEqual([]);
  });

  it("indexer URL failing: head-tracking reads continue through the grounding URL", async () => {
    chainstack.down = true;
    await headTracking(client());
    expect(alchemy.calls).toEqual(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs", "eth_getTransactionReceipt", "eth_call"]);
    expect(chainstack.calls.length).toBeGreaterThan(0);
  });

  it("indexer URL unreachable: head-tracking reads continue through the grounding URL", async () => {
    const dead = await stub();
    dead.server.close();
    const c = createPublicClient({ transport: indexerTransport({ indexer: dead.url, grounding: alchemy.url }) });
    expect(await c.request({ method: "eth_blockNumber" })).toBe("0x10");
    expect(alchemy.calls).toEqual(["eth_blockNumber"]);
  });
});

describe("Chainstack leg", () => {
  const capped = () => createPublicClient({ transport: cappedLogs(http(chainstack.url, { retryCount: 0 }), CHAINSTACK_LOGS_RANGE) });

  it(`sends a range eth_getLogs of up to ${CHAINSTACK_LOGS_RANGE} blocks`, async () => {
    await capped().request({ method: "eth_getLogs", params: [{ fromBlock: hex(1), toBlock: hex(CHAINSTACK_LOGS_RANGE) } as never] });
    expect(chainstack.calls).toEqual(["eth_getLogs"]);
  });

  it(`never sends one over ${CHAINSTACK_LOGS_RANGE} blocks, or one ending at a tag`, async () => {
    await expect(capped().request({ method: "eth_getLogs", params: [{ fromBlock: hex(1), toBlock: hex(CHAINSTACK_LOGS_RANGE + 1) } as never] })).rejects.toThrow(/not sent/);
    await expect(capped().request({ method: "eth_getLogs", params: [{ fromBlock: hex(1), toBlock: "latest" } as never] })).rejects.toThrow(/not sent/);
    expect(chainstack.calls).toEqual([]);
  });
});

describe("grounding client", () => {
  it("is built from the grounding variable only, and sends nothing to the indexer URL", async () => {
    const env = { READER_BASE_RPC_URL: chainstack.url, READER_BASE_GROUNDING_RPC_URL: alchemy.url };
    const g = groundingClient(CHAINS[8453]!, env);
    await g.request({ method: "eth_getLogs", params: [{ fromBlock: hex(1), toBlock: hex(5_000_000) } as never] });
    await g.request({ method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "0x10"] as never });
    expect(alchemy.calls).toEqual(["eth_getLogs", "eth_call"]);
    expect(chainstack.calls).toEqual([]);
    expect(() => groundingClient(CHAINS[8453]!, { READER_BASE_RPC_URL: chainstack.url })).toThrow("READER_BASE_GROUNDING_RPC_URL is not set");
  });

  it("both variables are required per chain, by name", () => {
    expect(() => rpcUrls(CHAINS[42161]!, { READER_ARBITRUM_GROUNDING_RPC_URL: "x" })).toThrow("READER_ARBITRUM_RPC_URL is not set");
    expect(() => rpcUrls(CHAINS[42161]!, { READER_ARBITRUM_RPC_URL: "x" })).toThrow("READER_ARBITRUM_GROUNDING_RPC_URL is not set");
  });
});

describe("response ceiling (R-S197-7)", () => {
  const len = (r: unknown) => (r as string).length;

  it("READER_MAX_RESPONSE_BYTES is a bounded number above the largest observed Base block", () => {
    expect(typeof READER_MAX_RESPONSE_BYTES).toBe("number");
    expect(READER_MAX_RESPONSE_BYTES).toBeGreaterThan(LARGEST_BASE_BLOCK_BYTES);
    expect(fat(1).body.length).toBe(LARGEST_BASE_BLOCK_BYTES);
    expect(fat(123456).body.length).toBe(LARGEST_BASE_BLOCK_BYTES);
  });

  it("control: viem's default http transport refuses that block", async () => {
    chainstack.fat = true;
    const plain = createPublicClient({ transport: http(chainstack.url, { retryCount: 0 }) });
    await expect(plain.request({ method: "eth_getBlockByNumber", params: ["latest", true] })).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it("indexer leg: head tracking takes that block from the indexer URL", async () => {
    chainstack.fat = true;
    expect(len(await client().request({ method: "eth_getBlockByNumber", params: ["latest", true] }))).toBe(chainstack.served[0]);
    expect(chainstack.calls).toEqual(["eth_getBlockByNumber"]);
    expect(alchemy.calls).toEqual([]);
  });

  it("grounding leg: head tracking (indexer down) and backfill take that size from the grounding URL", async () => {
    chainstack.down = true;
    alchemy.fat = true;
    expect(len(await client().request({ method: "eth_getBlockByNumber", params: ["latest", true] }))).toBe(alchemy.served[0]);
    expect(len(await client().request({ method: "eth_getLogs", params: [{ fromBlock: hex(1), toBlock: hex(5_000_000) } as never] }))).toBe(alchemy.served[1]);
    expect(alchemy.calls).toEqual(["eth_getBlockByNumber", "eth_getLogs"]);
  });

  it("grounding client takes that size", async () => {
    alchemy.fat = true;
    const g = groundingClient(CHAINS[8453]!, { READER_BASE_GROUNDING_RPC_URL: alchemy.url });
    expect(len(await g.request({ method: "eth_getBlockByNumber", params: ["latest", true] }))).toBe(alchemy.served[0]);
  });
});

describe("transport URL redaction (R-S197-8)", () => {
  const KEYED = { indexer: "https://example.invalid/v2/FAKEKEY123", grounding: "https://example.invalid/v2/FAKEKEY456" };
  const leaks = (e: RpcRequestError) => [e.message, e.shortMessage, e.details, e.url, e.stack ?? "", ...(e.metaMessages ?? [])].join("\n");
  const throwing = (url: string, seen: RpcRequestError[]) =>
    custom(
      {
        request: async () => {
          const e = new RpcRequestError({ body: { method: "eth_blockNumber" }, error: { code: 123, message: `upstream failed at ${url}` }, url });
          seen.push(e);
          throw e;
        },
      },
      { retryCount: 0 },
    );

  it("an RpcRequestError from either injected leg surfaces with no URL or key, and keeps its class", async () => {
    const seen: RpcRequestError[] = [];
    const c = createPublicClient({ transport: indexerTransport(KEYED, { indexer: throwing(KEYED.indexer, seen), grounding: throwing(KEYED.grounding, seen) }) });
    const err = await c.request({ method: "eth_blockNumber" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcRequestError);
    expect(seen.length).toBe(2);
    for (const e of [err as RpcRequestError, ...seen]) {
      expect(e).toBeInstanceOf(RpcRequestError);
      expect(leaks(e)).not.toMatch(/example\.invalid|FAKEKEY/);
    }
    expect(leaks(seen[0]!)).toContain("[redacted:indexer]");
    expect(leaks(seen[1]!)).toContain("[redacted:grounding]");
    expect((err as RpcRequestError).details).toBe("upstream failed at [redacted:grounding]");
    expect((err as RpcRequestError).url).toBe("[redacted:grounding]");
  });

  it("the grounding client's HTTP error carries no URL or key", async () => {
    alchemy.down = true;
    const g = groundingClient(CHAINS[8453]!, { READER_BASE_GROUNDING_RPC_URL: `${alchemy.url}/v2/FAKEKEY789` });
    const err = (await g.request({ method: "eth_blockNumber" }).catch((e: unknown) => e)) as Error & { url?: string };
    expect(err).toBeInstanceOf(Error);
    expect([err.message, err.url, err.stack].join("\n")).not.toMatch(/127\.0\.0\.1|FAKEKEY/);
    expect(err.message).toContain("[redacted:grounding]");
  });
});
