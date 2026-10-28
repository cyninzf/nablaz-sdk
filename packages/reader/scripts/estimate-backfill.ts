// pnpm --filter @nablaz/reader estimate:backfill [--chunk <blocks>] [--max-range <blocks>]
//
// Prices a full-history backfill (R-S192-1: every source from its deployment block, both chains) and the
// steady state at head, in eth_getLogs calls and Alchemy compute units. Reads only the current head and a
// block-time sample from each chain's RPC (READER_ARB_RPC_URL, READER_BASE_RPC_URL); nothing else is fetched.
// Prints numbers, writes nothing: the numbers are not committed (S190-L4), this script is.
//
// CU per method, from the Alchemy compute-unit cost table (looked up Oct 28 2026):
//   https://www.alchemy.com/docs/reference/compute-unit-costs
//   eth_getLogs 60, eth_getBlockByNumber 20, eth_blockNumber 10.
// eth_getLogs block-range limits (https://www.alchemy.com/docs/reference/eth-getlogs): Arbitrum and Base,
// Pay As You Go and Enterprise unlimited, Free 10 blocks; every response capped at 150MB.
// Plan prices: https://www.alchemy.com/pricing (Pay As You Go $0.52 per 1M CU, Oct 28 2026).
//
// Chunking. The reader sets no ethGetLogsBlockRange, so Ponder 0.18.1 chunks dynamically: the first range is
// 500 blocks and each successful call grows it by 5%, until the RPC refuses a range and suggests one
// (node_modules/ponder/dist/esm/rpc/actions.js, eth_getLogsWithPagination). "ponder" simulates that growth,
// capped at --max-range (default unlimited, Alchemy's paid tiers on these chains): a floor, since a dense
// source (USDC AuthorizationUsed, all authorizers) can hit the 150MB cap and shrink the range. "fixed" is
// every call at --chunk blocks (default 10000): a conservative bound.
//
// Not counted: per-event calls the handlers make (block and receipt fetches, the vault envelope state reads),
// which scale with matched logs, not with blocks; and the reads' own grounding getLogs (src/grounding-rpc.ts).
//
// Steady state. Ponder's realtime sync polls each chain every 1 s (pollingInterval default) and, per new
// block, fetches the block (eth_getBlockByNumber) and its logs (one eth_getLogs by blockHash, for every
// source at once). Ponder skips the getLogs when no filter matches the block's logsBloom; that skip is not
// modelled, so the getLogs line is an upper bound.

import { createPublicClient, http } from "viem";
import { CHAINS, hasNabla, type ChainSources } from "../src/chains.ts";

const CU = { eth_getLogs: 60, eth_getBlockByNumber: 20, eth_blockNumber: 10 } as const;
const PONDER_START_RANGE = 500;
const PONDER_GROWTH = 1.05;
const POLL_SECONDS = 1;
const SAMPLE_BLOCKS = 100_000n;

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const fixedChunk = flag("--chunk", 10_000);
const maxRange = flag("--max-range", Number.POSITIVE_INFINITY);

/** Calls Ponder's dynamic pagination makes over `blocks`, assuming no call is refused. */
function ponderCalls(blocks: number): number {
  let range = PONDER_START_RANGE;
  let n = 0;
  for (let left = blocks; left > 0; n++) {
    const r = Math.min(Math.round(range), maxRange);
    left -= r;
    range = Math.min(range * PONDER_GROWTH, maxRange);
  }
  return n;
}
const fixedCalls = (blocks: number) => Math.ceil(blocks / fixedChunk);

/** One eth_getLogs filter per Ponder source, as ponder.config.ts registers them; a factory source is two. */
function sources(c: ChainSources): { name: string; from: number; filters: number }[] {
  const out: { name: string; from: number; filters: number }[] = [];
  if (hasNabla(c)) {
    const s = c.nabla.startBlock;
    out.push(
      { name: "NablaRecord", from: s, filters: 1 },
      { name: "AccountFactory", from: s, filters: 1 },
      { name: "AccountRegistry", from: s, filters: 1 },
      { name: "AccountProxyViaFactory", from: s, filters: 2 },
      { name: "AccountProxyViaRegistry", from: s, filters: 2 },
      { name: "Usdc", from: s, filters: 1 },
    );
  }
  const b = c.external.startBlocks;
  out.push(
    { name: "SpendPermissionManager", from: b.SpendPermissionManager, filters: 1 },
    { name: "DelegationManager", from: b.DelegationManager, filters: 1 },
    { name: "ReputationRegistry", from: b.ReputationRegistry, filters: 1 },
    { name: "IdentityRegistry", from: b.IdentityRegistry, filters: 1 },
  );
  if (c.external.creditLineLenders.length > 0) out.push({ name: "CreditLine", from: b.creditLineLenders, filters: 1 });
  return out;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const usd = (cu: number) => `$${((cu / 1e6) * 0.52).toFixed(2)}`;

const rows: string[][] = [["chain", "source", "from block", "blocks", "calls (ponder)", "CU (ponder)", "calls (fixed)", "CU (fixed)"]];
const steady: string[] = [];
let totalPonder = 0;
let totalFixed = 0;

for (const c of Object.values(CHAINS).filter((x) => x.enabled)) {
  const url = process.env[c.rpcEnv];
  if (!url) throw new Error(`${c.rpcEnv} is not set`);
  const client = createPublicClient({ transport: http(url) });
  const head = await client.getBlock({ blockTag: "latest" });
  const past = await client.getBlock({ blockNumber: head.number - SAMPLE_BLOCKS });
  const blockSeconds = Number(head.timestamp - past.timestamp) / Number(SAMPLE_BLOCKS);

  let chainPonder = 0;
  let chainFixed = 0;
  for (const s of sources(c)) {
    const blocks = Number(head.number) - s.from + 1;
    const p = ponderCalls(blocks) * s.filters;
    const f = fixedCalls(blocks) * s.filters;
    chainPonder += p;
    chainFixed += f;
    rows.push([c.name, s.name, String(s.from), fmt(blocks), fmt(p), fmt(p * CU.eth_getLogs), fmt(f), fmt(f * CU.eth_getLogs)]);
  }
  rows.push([c.name, "(chain total)", "", "", fmt(chainPonder), fmt(chainPonder * CU.eth_getLogs), fmt(chainFixed), fmt(chainFixed * CU.eth_getLogs)]);
  totalPonder += chainPonder;
  totalFixed += chainFixed;

  const blocksPerDay = 86_400 / blockSeconds;
  const blockCalls = Math.max(blocksPerDay, 86_400 / POLL_SECONDS);
  const dayCu = blockCalls * CU.eth_getBlockByNumber + blocksPerDay * CU.eth_getLogs;
  steady.push(
    `${c.name}: head ${head.number}, ${blockSeconds.toFixed(3)} s/block over the last ${SAMPLE_BLOCKS} blocks; ` +
      `per day ${fmt(blockCalls)} eth_getBlockByNumber + up to ${fmt(blocksPerDay)} eth_getLogs = up to ${fmt(dayCu)} CU ` +
      `(${usd(dayCu)}/day, ${usd(dayCu * 30)}/30 days at Pay As You Go)`,
  );
}
rows.push(["all", "(total)", "", "", fmt(totalPonder), fmt(totalPonder * CU.eth_getLogs), fmt(totalFixed), fmt(totalFixed * CU.eth_getLogs)]);

const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
console.log(`backfill, eth_getLogs only; ponder = dynamic from ${PONDER_START_RANGE} blocks x${PONDER_GROWTH}, max range ${maxRange}; fixed = ${fixedChunk} blocks per call`);
for (const r of rows) console.log(r.map((v, i) => (i < 2 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!))).join("  "));
console.log(`backfill CU at Pay As You Go: ponder ${usd(totalPonder * CU.eth_getLogs)}, fixed ${usd(totalFixed * CU.eth_getLogs)}`);
console.log("steady state at head (upper bound, logsBloom skip not modelled):");
for (const s of steady) console.log(`  ${s}`);
