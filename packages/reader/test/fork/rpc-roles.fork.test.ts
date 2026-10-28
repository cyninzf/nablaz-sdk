// RPC roles end to end (R-S192-8, R-S192-4 AMENDED), on Base, read-only. Each role's URL is a counting proxy
// (harness.ts) in front of the upstream, so every assertion is on the calls a proxy received.
//   1. A grounding read, registry logs path (src/grounding-rpc.ts, through the client src/api/index.ts uses), on
//      one row of AFG's fixture: the indexer URL receives nothing; the grounding URL receives the registry
//      eth_getLogs and the binding reads.
//   2. The indexer following the head (Base, external sources, from a few blocks behind the head): in normal
//      operation the grounding URL receives range eth_getLogs (backfill) and nothing else, so no head-tracking
//      call reaches it; the indexer URL receives no range eth_getLogs.
//   3. Then the indexer URL goes down: the indexer keeps advancing, its head-tracking calls now through the
//      grounding URL.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, getAddress, http } from "viem";
import { CHAINS } from "../../src/chains";
import { bindingsAtTransferBlocks, boundHistory, transfersFrom, walletAt } from "../../src/grounding-rpc";
import { groundingClient, isRangeGetLogs } from "../../src/rpc";
import { UPSTREAM_BASE, UPSTREAM_BASE_GROUNDING, countingProxy, indexOnce, type CountingProxy, type RpcCall, type Served } from "./harness";

if (!UPSTREAM_BASE) throw new Error("READER_BASE_RPC_URL is not set: the fork tests do not skip");
const GROUNDING_UPSTREAM = UPSTREAM_BASE_GROUNDING ?? UPSTREAM_BASE;

const BASE = CHAINS[8453]!;
const REGISTRY = BASE.external.IdentityRegistry!;
const FIXTURE = new URL("../fixtures/afg/erc8004-base-grounded-feedback-2026-10-20.derived.csv", import.meta.url);
const [head, first] = readFileSync(FIXTURE, "utf8").trim().split("\n");
const ROW = Object.fromEntries(first!.split(",").map((v, i) => [head!.split(",")[i], v])) as Record<string, string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const methods = (calls: RpcCall[]) => [...new Set(calls.map((c) => c.method))].sort();
const addressOf = (c: RpcCall) => String(((c.params as { address?: string; to?: string }[])[0] ?? {}).address ?? ((c.params as { to?: string }[])[0] ?? {}).to ?? "").toLowerCase();

describe("grounding read", () => {
  it("never touches the indexer URL (registry logs path)", async () => {
    const indexer = await countingProxy(UPSTREAM_BASE!);
    const grounding = await countingProxy(GROUNDING_UPSTREAM);
    try {
      // Both variables set, as on the hosted instance; the client is the one GET /read builds.
      const client = groundingClient(BASE, { READER_BASE_RPC_URL: indexer.url, READER_BASE_GROUNDING_RPC_URL: grounding.url });
      const agentId = BigInt(ROW.agent_id!);
      const block = BigInt(ROW.feedback_block!);
      const from = BigInt(BASE.external.startBlocks.IdentityRegistry);
      const candidates = await boundHistory(client, REGISTRY, agentId, from, block);
      const transfers = await transfersFrom(client, 8453, getAddress(ROW.rater!), from, block);
      await bindingsAtTransferBlocks(client, REGISTRY, agentId, transfers, candidates);
      await walletAt(client, REGISTRY, agentId, block);
      expect(candidates.size).toBeGreaterThan(0);

      expect(indexer.calls).toEqual([]);
      const registryLogs = grounding.calls.filter((c) => c.method === "eth_getLogs" && addressOf(c) === REGISTRY.toLowerCase());
      expect(registryLogs.length).toBeGreaterThan(0);
      expect(grounding.calls.some((c) => c.method === "eth_call" && addressOf(c) === REGISTRY.toLowerCase())).toBe(true);
    } finally {
      await indexer.stop();
      await grounding.stop();
    }
  });
});

describe("indexer following the head", () => {
  let indexer: CountingProxy;
  let grounding: CountingProxy;
  let served: Served;
  const blockOf = async () => ((await (await fetch(`${served.url}/status`)).json()) as Record<string, { block: { number: number } }>).base!.block.number;

  beforeAll(async () => {
    indexer = await countingProxy(UPSTREAM_BASE!);
    grounding = await countingProxy(GROUNDING_UPSTREAM);
    const tip = await createPublicClient({ transport: http(UPSTREAM_BASE) }).getBlockNumber();
    served = await indexOnce({ baseRpcUrl: indexer.url, baseGroundingRpcUrl: grounding.url, chains: "8453", sources: "external", startBlock: Number(tip) - 20, serve: true });
  });
  afterAll(async () => {
    await served?.stop();
    await indexer?.stop();
    await grounding?.stop();
  });

  it("normal operation: zero head-tracking calls reach the grounding URL", async () => {
    const start = await blockOf();
    await sleep(30_000);
    expect(await blockOf()).toBeGreaterThan(start);
    const notBackfill = grounding.calls.filter((c) => !isRangeGetLogs(c.method, c.params));
    expect(notBackfill).toEqual([]);
    expect(indexer.calls.filter((c) => isRangeGetLogs(c.method, c.params))).toEqual([]);
    expect(methods(indexer.calls)).toContain("eth_getBlockByNumber");
  });

  it("indexer URL down: the indexer keeps advancing through the grounding URL", async () => {
    indexer.failing = true;
    const before = grounding.calls.length;
    await sleep(5_000);
    const start = await blockOf();
    await sleep(30_000);
    expect(await blockOf()).toBeGreaterThan(start);
    const failover = grounding.calls.slice(before).filter((c) => !isRangeGetLogs(c.method, c.params));
    expect(methods(failover)).toContain("eth_getBlockByNumber");
  });
});
