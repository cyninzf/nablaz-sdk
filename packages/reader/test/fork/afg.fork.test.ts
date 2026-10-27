// This reader's grounding (R-D2B-2) on every row of AFG's grounded-feedback fixture (Base, CC BY 4.0;
// test/fixtures/afg/README.md). Per row, read-only against Base: the NewFeedback log at the row's transaction
// and log index, getAgentWallet at the feedback block and the block before, and the payment facts this reader
// produces from AFG's payment transaction (SpendPermissionUsed; a delegator's ERC-20 Transfer beside a
// RedeemedDelegation), decoded by the reader's own code. The comparison is written to
// docs/reader/afg-agreement-2026-10-20.csv (AFG_WRITE=1) and otherwise must equal it. The agreement rate is logged.
//
// Scope of the comparison: AFG names one payment per feedback (the most recent before it). This test reads
// that transaction only; it does not index the rater's other payments.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPublicClient, decodeEventLog, getAddress, http, type Address, type Hex, type Log } from "viem";
import { CHAINS } from "../../src/chains";
import { decodeRedeemedDelegation, delegationHash, erc20TransfersFrom, type Delegation, type ReceiptLogLike } from "../../src/delegation";
import { IdentityRegistryAbi, ReputationRegistryAbi, SpendPermissionManagerAbi } from "../../src/external-abis";
import { SPM_LABEL, shapeOfDelegation } from "../../src/labels";
import { groundingFact, paymentFacts, type GroundingPayment } from "../../src/read";
import { UPSTREAM_BASE } from "./harness";

if (!UPSTREAM_BASE) throw new Error("READER_BASE_RPC_URL is not set: the fork tests do not skip");

const FIXTURE = new URL("../fixtures/afg/erc8004-base-grounded-feedback-2026-10-20.derived.csv", import.meta.url);
const RESULT = new URL("../../../../docs/reader/afg-agreement-2026-10-20.csv", import.meta.url);
const BASE = CHAINS[8453]!.external;
const ZERO = "0x0000000000000000000000000000000000000000";
const client = createPublicClient({ transport: http(UPSTREAM_BASE) });

type Row = { feedback_id: string; agent_id: string; rater: string; feedback_block: string; feedback_tx: Hex; payment_tx: Hex; payee: string; rail: string };
const rows: Row[] = (() => {
  const [head, ...lines] = readFileSync(FIXTURE, "utf8").trim().split("\n");
  const keys = head!.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v])) as Row);
})();

const receipts = new Map<string, Promise<{ logs: Log[] }>>();
const receipt = (hash: Hex) => {
  if (!receipts.has(hash)) receipts.set(hash, client.getTransactionReceipt({ hash }) as Promise<{ logs: Log[] }>);
  return receipts.get(hash)!;
};
const walletAt = async (agentId: bigint, blockNumber: bigint) => {
  const a = await client.readContract({ address: BASE.IdentityRegistry!, abi: IdentityRegistryAbi, functionName: "getAgentWallet", args: [agentId], blockNumber });
  return a === ZERO ? null : getAddress(a);
};
const lc = (a: string) => a.toLowerCase();

/** The payment facts the reader's handlers would write for one transaction (src/external.ts). */
async function paymentsIn(tx: Hex): Promise<GroundingPayment[]> {
  const { logs } = await receipt(tx);
  const like: ReceiptLogLike[] = logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data, logIndex: l.logIndex! }));
  const rows: Record<string, unknown>[] = [];
  const perms = new Map<string, Record<string, unknown>>();
  for (const l of logs) {
    const ev = { chainId: 8453, blockNumber: l.blockNumber, txHash: tx, logIndex: l.logIndex, reproduce: "" };
    if (lc(l.address) === lc(BASE.SpendPermissionManager!)) {
      const d = (() => {
        try {
          return decodeEventLog({ abi: SpendPermissionManagerAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        } catch {
          return null;
        }
      })();
      if (d?.eventName !== "SpendPermissionUsed") continue;
      const a = d.args as { hash: Hex; account: Address; spender: Address; token: Address; periodSpend: { spend: bigint } };
      perms.set(`8453-spm-${lc(a.hash)}`, { label: SPM_LABEL, shape: "a" });
      rows.push({ ...ev, source: "spm", payer: a.account, payee: a.spender, token: a.token, amount: a.periodSpend.spend, permissionId: a.hash });
    }
    if (lc(l.address) === lc(BASE.DelegationManager!) && l.topics.length > 0) {
      const r = (() => {
        try {
          return decodeRedeemedDelegation({ topics: l.topics as Hex[], data: l.data });
        } catch {
          return null;
        }
      })();
      if (!r) continue;
      const hash = delegationHash(r.delegation as unknown as Delegation);
      const shape = shapeOfDelegation(r.delegation.caveats);
      perms.set(`8453-dm-${lc(hash)}`, { label: shape.label, shape: shape.shape });
      for (const t of erc20TransfersFrom(like, [r.delegation.delegator, r.rootDelegator]).filter((x) => lc(x.from) === lc(r.delegation.delegator)))
        rows.push({ ...ev, logIndex: t.logIndex, source: "delegation_manager", payer: t.from, payee: t.to, token: t.token, amount: t.amount, permissionId: hash });
    }
  }
  return paymentFacts(rows, perms).map((fact, i) => ({
    fact,
    payer: getAddress(String(rows[i]!.payer)),
    payee: getAddress(String(rows[i]!.payee)),
    block: BigInt(String(rows[i]!.blockNumber)),
    logIndex: Number(rows[i]!.logIndex),
  }));
}

async function evaluate(row: Row): Promise<{ ours: string; reason: string }> {
  const [tx, logHex] = row.feedback_id.split(":") as [Hex, string];
  const { logs } = await receipt(tx);
  const log = logs.find((l) => l.logIndex === Number(logHex));
  if (!log) return { ours: "not determinable", reason: "feedback log not found at the row's transaction and log index" };
  const fb = decodeEventLog({ abi: ReputationRegistryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as { agentId: bigint; clientAddress: Address; feedbackIndex: bigint };
  if (fb.agentId.toString() !== row.agent_id || lc(fb.clientAddress) !== lc(row.rater)) return { ours: "not determinable", reason: "the feedback log does not match the row's agent_id and rater" };
  const block = log.blockNumber!;
  const wallet = { before: await walletAt(fb.agentId, block - 1n), at: await walletAt(fb.agentId, block) };
  const payments = await paymentsIn(row.payment_tx);
  const g = groundingFact({
    subject: wallet.at ?? ZERO,
    feedback: { chainId: 8453, blockNumber: block, txHash: tx, logIndex: log.logIndex, reproduce: "", agentId: fb.agentId, client: fb.clientAddress, feedbackIndex: fb.feedbackIndex },
    wallet,
    payments,
    paymentsFrom: 0,
    raterController: null,
    subjectController: null,
  })!;
  const t = g.terms as { grounding: string; reason?: string };
  if (t.grounding === "grounded") return { ours: "grounded", reason: `payment fact ${(t as any).payment.source} in AFG's payment tx` };
  if (t.grounding === "not determinable") return { ours: t.grounding, reason: t.reason! };
  const payee = row.payee.split(":").at(-1)!;
  if (wallet.at && lc(wallet.at) !== lc(payee)) return { ours: t.grounding, reason: `agentWallet at the feedback block is ${wallet.at}, not AFG's payee ${getAddress(payee)}` };
  if (payments.length === 0) return { ours: t.grounding, reason: `AFG's payment tx carries no payment fact this reader produces (rail ${row.rail}: a plain ERC-20 transfer is not one)` };
  return { ours: t.grounding, reason: "AFG's payment tx carries payment facts, none from the rater to the agentWallet before the feedback" };
}

async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await f(xs[i]!);
    }
  }));
  return out;
}

describe("AFG fixture (Base, 816 grounded feedback entries)", () => {
  it("every row evaluated; agreement rate logged; result equals docs/reader/afg-agreement-2026-10-20.csv", async () => {
    expect(rows).toHaveLength(816);
    const results = await pool(rows, 8, evaluate);
    const csv = [
      "feedback_id,agent_id,rater,feedback_block,payment_tx,rail,afg,ours,reason",
      ...rows.map((r, i) => [r.feedback_id, r.agent_id, r.rater, r.feedback_block, r.payment_tx, r.rail, "grounded", results[i]!.ours, `"${results[i]!.reason}"`].join(",")),
    ].join("\n") + "\n";
    const agree = results.filter((r) => r.ours === "grounded").length;
    const byReason = new Map<string, number>();
    for (const r of results) if (r.ours !== "grounded") byReason.set(`${r.ours}: ${r.reason.replace(/0x[0-9a-fA-F]{40}/g, "<address>")}`, (byReason.get(`${r.ours}: ${r.reason.replace(/0x[0-9a-fA-F]{40}/g, "<address>")}`) ?? 0) + 1);
    console.log(`AFG agreement: ${agree}/${rows.length} rows grounded by this reader (${((agree * 100) / rows.length).toFixed(2)}%)`);
    for (const [k, v] of byReason) console.log(`  disagreement x${v}: ${k}`);
    if (process.env.AFG_WRITE) writeFileSync(RESULT, csv);
    expect(csv).toBe(readFileSync(RESULT, "utf8"));
  }, 1_200_000);
});
