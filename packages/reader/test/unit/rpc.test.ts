// RPC roles (R-S192-8, R-S192-4 AMENDED), against two stub JSON-RPC servers on 127.0.0.1 that record every call
// they receive. Counts are taken at the servers, not read from the config.
//   Normal operation: no head-tracking call reaches the grounding (Alchemy) URL; range eth_getLogs reach it only.
//   Indexer (Chainstack) URL down: head-tracking calls continue through the grounding URL.
//   The Chainstack leg never sends a range eth_getLogs over CHAINSTACK_LOGS_RANGE blocks.
//   The grounding client sends nothing to the indexer URL.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublicClient, http, type PublicClient } from "viem";
import { CHAINS } from "../../src/chains";
import { CHAINSTACK_LOGS_RANGE, cappedLogs, groundingClient, indexerTransport, rpcUrls } from "../../src/rpc";

type Stub = { url: string; calls: string[]; down: boolean; server: Server };

async function stub(): Promise<Stub> {
  const s: Stub = { url: "", calls: [], down: false, server: undefined as never };
  s.server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const { id, method } = JSON.parse(body) as { id: number; method: string };
    s.calls.push(method);
    if (s.down) return res.writeHead(503).end("down");
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
