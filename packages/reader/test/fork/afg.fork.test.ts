// This reader's grounding (R-D2B-2 as corrected by R-S191-11/12/16) on every row of AFG's grounded-feedback fixture
// (Base, CC BY 4.0; test/fixtures/afg/README.md). Per row, read-only against Base, with the reader's own code
// (src/grounding-rpc.ts, src/read.ts): the NewFeedback log at the row's transaction and log index; every ERC-20
// Transfer from the rater (eth_getLogs, topic1 = rater, any token) over blocks IDENTITY_START..feedback block; the
// binding at each candidate transfer's block (agentWallet, else owner; candidates from the agentWallet and owner
// histories); the wallet at the feedback block, reported beside it. Labels
// come from decoding the grounding transaction (SpendPermissionUsed; a delegator's Transfer beside a
// RedeemedDelegation); any other transfer is (c), direct transfer. The comparison is written to
// docs/reader/afg-agreement-2026-10-20.csv (AFG_WRITE=1, replacing it) and otherwise must equal it.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPublicClient, decodeEventLog, getAddress, http, type Address, type Hex, type Log, type PublicClient } from "viem";
import { CHAINS } from "../../src/chains";
import { decodeRedeemedDelegation, delegationHash, erc20TransfersFrom, type Delegation, type ReceiptLogLike } from "../../src/delegation";
import { ReputationRegistryAbi, SpendPermissionManagerAbi } from "../../src/external-abis";
import { bindingAt, bindingsAtTransferBlocks, boundHistory, transfersFrom, walletAt } from "../../src/grounding-rpc";
import { SPM_LABEL, shapeOfDelegation } from "../../src/labels";
import { groundingFact, groundingTransfers, paymentFacts, type GroundingPayment, type LabelledPayment, type RaterTransfer } from "../../src/read";
import { UPSTREAM_BASE } from "./harness";

if (!UPSTREAM_BASE) throw new Error("READER_BASE_RPC_URL is not set: the fork tests do not skip");

const FIXTURE = new URL("../fixtures/afg/erc8004-base-grounded-feedback-2026-10-20.derived.csv", import.meta.url);
const RESULT = new URL("../../../../docs/reader/afg-agreement-2026-10-20.csv", import.meta.url);
const BASE = CHAINS[8453]!.external;
const ZERO = "0x0000000000000000000000000000000000000000";
const client = createPublicClient({ transport: http(UPSTREAM_BASE) }) as PublicClient;
/** The Identity Registry's first block with code on Base: no agentWallet, so no grounding transfer, is older. */
const IDENTITY_START = BigInt(BASE.startBlocks.IdentityRegistry);

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
const lc = (a: string) => a.toLowerCase();

/** The payment facts the reader's handlers would write for one transaction (src/external.ts). */
type TxPayment = Omit<GroundingPayment, "binding">;

async function paymentsIn(tx: Hex): Promise<TxPayment[]> {
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

const lastFeedback = new Map<string, bigint>();
for (const r of rows) {
  const k = r.rater.toLowerCase();
  if ((lastFeedback.get(k) ?? 0n) < BigInt(r.feedback_block)) lastFeedback.set(k, BigInt(r.feedback_block));
}
const raterTransfers = new Map<string, Promise<RaterTransfer[]>>();
const transfersOf = (rater: string) => {
  const k = rater.toLowerCase();
  if (!raterTransfers.has(k)) raterTransfers.set(k, transfersFrom(client, 8453, getAddress(rater), IDENTITY_START, lastFeedback.get(k)!));
  return raterTransfers.get(k)!;
};

/** Labels for the transfers in one transaction: the payment facts the reader's handlers would write for it. */
async function labelsIn(tx: Hex, transfers: RaterTransfer[]): Promise<LabelledPayment[]> {
  const out: LabelledPayment[] = [];
  for (const p of await paymentsIn(tx)) {
    const spm = p.fact.source === "coinbase:spend_permission_payment";
    const t = transfers.find((x) => x.tx === tx && (spm ? lc(x.to) === lc(p.payee) && x.amount === BigInt(String((p.fact.terms as any).amount)) : x.logIndex === p.logIndex));
    if (t) out.push({ fact: p.fact, tx, transferLogIndex: t.logIndex });
  }
  return out;
}

type Result = { ours: string; ourPaymentTx: string; label: string; binding: string; walletAtFeedback: string; reason: string };

async function evaluate(row: Row): Promise<Result> {
  const [tx, logHex] = row.feedback_id.split(":") as [Hex, string];
  const { logs } = await receipt(tx);
  const log = logs.find((l) => l.logIndex === Number(logHex));
  const none = { ourPaymentTx: "", label: "", binding: "", walletAtFeedback: "" };
  if (!log) return { ours: "not determinable", ...none, reason: "feedback log not found at the row's transaction and log index" };
  const fb = decodeEventLog({ abi: ReputationRegistryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as { agentId: bigint; clientAddress: Address; feedbackIndex: bigint };
  if (fb.agentId.toString() !== row.agent_id || lc(fb.clientAddress) !== lc(row.rater)) return { ours: "not determinable", ...none, reason: "the feedback log does not match the row's agent_id and rater" };
  const block = log.blockNumber!;
  const prior = (await transfersOf(row.rater)).filter((t) => t.block <= block);
  const history = await boundHistory(client, BASE.IdentityRegistry!, fb.agentId, IDENTITY_START, block);
  const bindings = await bindingsAtTransferBlocks(client, BASE.IdentityRegistry!, fb.agentId, prior, history);
  const candidateTxs = [...new Set(prior.filter((t) => { const b = bindings(t.block); return b && b.kind !== "none" && lc(b.address) === lc(t.to); }).map((t) => t.tx))];
  const labelled = (await Promise.all(candidateTxs.map((h) => labelsIn(h, prior)))).flat();
  const g = groundingFact({
    subject: fb.clientAddress,
    feedback: { chainId: 8453, blockNumber: block, txHash: tx, logIndex: log.logIndex, reproduce: "", agentId: fb.agentId, client: fb.clientAddress, feedbackIndex: fb.feedbackIndex },
    payments: groundingTransfers(prior, bindings, labelled),
    transfersRange: { from: Number(IDENTITY_START), to: block },
    walletAtFeedback: await walletAt(client, BASE.IdentityRegistry!, fb.agentId, block),
    raterController: null,
    subjectController: null,
  });
  const t = g.terms as { grounding: string; reason?: string; binding?: string; walletAtFeedback: string; payment?: { cite: { tx: string }; label: string; source: string } };
  const base = { ourPaymentTx: t.payment?.cite.tx ?? "", label: t.payment ? `${t.payment.source} ${t.payment.label}` : "", binding: t.binding ?? "", walletAtFeedback: t.walletAtFeedback };
  if (t.grounding === "grounded") return { ours: "grounded", ...base, reason: t.payment!.cite.tx === row.payment_tx ? "same payment as AFG" : "grounded by another rater transfer than AFG's payment" };
  if (t.grounding === "not determinable") return { ours: t.grounding, ...base, reason: t.reason! };
  // Not grounded: say what the chain shows about AFG's payee at AFG's payment block.
  const payee = row.payee.split(":").at(-1)!;
  const afgPay = (await receipt(row.payment_tx)).logs[0]?.blockNumber;
  const at = afgPay ? await bindingAt(client, BASE.IdentityRegistry!, fb.agentId, afgPay) : null;
  const atText = !at ? "unread" : at.kind === "none" ? "identity did not exist" : `${at.kind} ${at.address}`;
  if (t.reason === "identity did not exist at the payment block") return { ours: t.grounding, ...base, reason: `identity did not exist at the payment block (AFG's payee ${history.has(lc(payee)) ? "was bound to it later" : "was never bound to it"})` };
  if (at && at.kind !== "none" && lc(at.address) === lc(payee)) return { ours: t.grounding, ...base, reason: `AFG's payee was bound at its payment block (${atText}), yet no rater Transfer to it was found before the feedback` };
  return { ours: t.grounding, ...base, reason: `AFG's payee was not the bound address at AFG's payment block (bound there: ${atText})` };
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
      "feedback_id,agent_id,rater,feedback_block,afg_payment_tx,rail,afg,ours,our_payment_tx,our_payment_label,binding,wallet_at_feedback,reason",
      ...rows.map((r, i) => {
        const x = results[i]!;
        return [r.feedback_id, r.agent_id, r.rater, r.feedback_block, r.payment_tx, r.rail, "grounded", x.ours, x.ourPaymentTx, `"${x.label}"`, `"${x.binding}"`, `"${x.walletAtFeedback}"`, `"${x.reason}"`].join(",");
      }),
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
