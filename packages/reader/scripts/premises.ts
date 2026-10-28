// B4 part 1 step 0: P0-3 (RedeemedDelegation decodes), P0-4 (SpendPermissionManager), P0-6 (Agent Credit
// Lines topic scan) on Arbitrum One and Base. Writes JSON to the path given; docs/reader/b4-part1.md is
// the committed record of one run. RPC URLs come from READER_ARBITRUM_RPC_URL / READER_BASE_RPC_URL and are
// never printed.
//
//   node --experimental-strip-types scripts/premises.ts <out.json>

import { writeFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, http, parseAbi, toEventSelector, type Address, type Hex, type Log } from "viem";
import {
  ROOT_AUTHORITY,
  decodeRedeemedDelegation,
  delegationHash,
  erc20TransfersFrom,
  hopOf,
} from "../src/delegation.ts";
import { shapeOfDelegation } from "../src/labels.ts";
import { CREDIT_LINE_EVENTS, SpendPermissionManagerAbi } from "../src/external-abis.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: premises.ts <out.json>");

const CHAINS = [
  { chainId: 42161, rpcEnv: "READER_ARBITRUM_RPC_URL" },
  { chainId: 8453, rpcEnv: "READER_BASE_RPC_URL" },
] as const;
const DM: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const SPM: Address = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
const REDEEMED = "0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873";

async function pagedLogs(
  client: ReturnType<typeof createPublicClient>,
  q: { address?: Address; topics: (Hex | null)[] },
  head: bigint,
  want: number,
  step: bigint,
  maxBlocks: bigint,
) {
  const logs: Log[] = [];
  let to = head;
  const floor = head - maxBlocks;
  while (logs.length < want && to > floor) {
    const from = to - step + 1n > floor ? to - step + 1n : floor;
    let got: Log[];
    try {
      got = (await client.request({
        method: "eth_getLogs",
        params: [{ ...(q.address ? { address: q.address } : {}), topics: q.topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      })) as Log[];
    } catch (e) {
      // Provider range or result-size cap: halve the window and retry.
      if (step <= 1n) throw e;
      step /= 2n;
      continue;
    }
    logs.unshift(...got);
    to = from - 1n;
  }
  return { logs: logs.slice(-want), scannedFrom: to + 1n, scannedTo: head };
}

const result: Record<string, unknown> = {};
for (const c of CHAINS) {
  const url = process.env[c.rpcEnv];
  if (!url) throw new Error(`${c.rpcEnv} MISSING`);
  const client = createPublicClient({ transport: http(url, { retryCount: 5 }) });
  const head = await client.getBlockNumber();

  // P0-3: the latest 12 redemptions (≥10 required).
  const red = await pagedLogs(client, { address: DM, topics: [REDEEMED] }, head, 12, 5_000n, 2_000_000n);
  const redemptions = [];
  for (const l of red.logs) {
    const r = decodeRedeemedDelegation(l as { topics: Hex[]; data: Hex });
    const d = r.delegation;
    const hash = delegationHash(d);
    const receipt = await client.getTransactionReceipt({ hash: l.transactionHash! });
    const siblings = receipt.logs.filter((x) => x.address.toLowerCase() === DM.toLowerCase() && x.topics[0] === REDEEMED);
    const chainHashes = siblings.map((x) => delegationHash(decodeRedeemedDelegation(x as { topics: Hex[]; data: Hex }).delegation));
    const transfers = erc20TransfersFrom(
      receipt.logs.map((x) => ({ address: x.address, topics: x.topics as Hex[], data: x.data, logIndex: x.logIndex })),
      [d.delegator, r.rootDelegator],
    );
    const shape = shapeOfDelegation(d.caveats);
    redemptions.push({
      block: BigInt(l.blockNumber!).toString(),
      tx: l.transactionHash,
      logIndex: Number(l.logIndex),
      rootDelegator: r.rootDelegator,
      redeemer: r.redeemer,
      delegate: d.delegate,
      delegator: d.delegator,
      authority: d.authority,
      hop: hopOf(d),
      authorityIsParentInTx: d.authority.toLowerCase() === ROOT_AUTHORITY ? null : chainHashes.includes(d.authority.toLowerCase() as Hex),
      redeemedEventsInTx: siblings.length,
      delegationHash: hash,
      enforcers: shape.enforcers.map((e) => ({ address: e.enforcer, name: e.name, class: e.class, mode: e.mode })),
      shape: shape.shape,
      label: shape.label,
      erc20TransfersFromDelegator: transfers.map((t) => ({ ...t, amount: t.amount.toString() })),
    });
  }

  // P0-4: ≥10 Used, ≥3 Approved; Revoked counted over the same window as Approved.
  const used = await pagedLogs(client, { address: SPM, topics: [toEventSelector(SpendPermissionManagerAbi[2])] }, head, 10, 200_000n, 60_000_000n);
  const approved = await pagedLogs(client, { address: SPM, topics: [toEventSelector(SpendPermissionManagerAbi[0])] }, head, 3, 500_000n, 60_000_000n);
  const revoked = await pagedLogs(client, { address: SPM, topics: [toEventSelector(SpendPermissionManagerAbi[1])] }, head, 1, 500_000n, 60_000_000n);
  const dec = (l: Log) => {
    const e = decodeEventLog({ abi: SpendPermissionManagerAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
    return {
      block: BigInt(l.blockNumber!).toString(),
      tx: l.transactionHash,
      logIndex: Number(l.logIndex),
      topicCount: l.topics.length,
      dataWord1: `0x${l.data.slice(66, 130)}`,
      event: e.eventName,
      args: JSON.parse(JSON.stringify(e.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
    };
  };

  // P0-6: topic-only scans over the last 2M blocks, any emitter.
  const creditLines: Record<string, unknown> = {};
  for (const ev of CREDIT_LINE_EVENTS) {
    const topic = toEventSelector(ev);
    const scan = await pagedLogs(client, { topics: [topic] }, head, Number.MAX_SAFE_INTEGER, 100_000n, 2_000_000n);
    creditLines[ev.name] = { topic0: topic, hits: scan.logs.length, from: scan.scannedFrom.toString(), to: scan.scannedTo.toString() };
  }

  result[c.chainId] = {
    head: head.toString(),
    redemptions: { from: red.scannedFrom.toString(), to: red.scannedTo.toString(), rows: redemptions },
    spm: {
      used: { from: used.scannedFrom.toString(), rows: used.logs.map(dec) },
      approved: { from: approved.scannedFrom.toString(), rows: approved.logs.map(dec) },
      revoked: { from: revoked.scannedFrom.toString(), rows: revoked.logs.map(dec) },
    },
    creditLines,
  };
  console.log(`chain ${c.chainId}: ${redemptions.length} redemptions, ${used.logs.length} used, ${approved.logs.length} approved, ${revoked.logs.length} revoked`);
}
writeFileSync(out, JSON.stringify(result, null, 2));
