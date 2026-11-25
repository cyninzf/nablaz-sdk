// GET /read/:chainId/tx/:txHash, the any-hash door (R-S219-6, R-S226-4): a transaction hash resolved to the record
// facts it anchors, built by the same fact builders as GET /read/:chainId/:address (src/read.ts), so each fact carries
// the same source, label, citation and reproducing one-liner as on the subject page. src/api/index.ts runs the queries
// and the chain lookup; this file holds the flag, the parsing and the answer.
//
// OFF unless TX_ENV is exactly "on" (the S213-SE7 NABLAZ_FEED pattern): off, every request answers 503
// {"ready":false} at once and issues no statement. It stays off until the next schema event ships a tx_hash index on
// every table in TX_SEARCHED (R-S226-4): without one, each lookup is a sequential scan, and two of these tables hold
// millions of rows (R-S217-1).
//
// A hash the record does not hold is a 404 whose BODY says why (S222); `reason` is one of:
//   not-indexed     the chain has the transaction above the indexed block, or still pending;
//   no-fact         the chain has it at or below the indexed block, and it anchors no fact the record holds;
//   unknown-hash    the chain has no such transaction;
//   not-determinable  the chain lookup failed, so which of the three is not known.
// An unread chain answers GET /read's own {"error":"chain N is not read here"}, unchanged.
//
// Subject (R-S231-8): every fact names the address whose GET /read page carries it, taken from a column of its own
// cited row that GET /read selects that table on (src/api/index.ts), lower-case as /feed. `subjectField` names the
// column, so the link is read off the citation, not asserted. Both are always present; a kind without such a column
// serves null for both and a `subjectReason`, never an absent field. Here, not in src/read.ts: src/api/** is outside
// Ponder's build id (scripts/bid.mjs), so this changes no index.

import { getAddress, type Hex } from "viem";
import type { NablaLabel } from "../labels";
import {
  creditLineFacts,
  notDeterminableNotes,
  paymentFacts,
  permissionFacts,
  recordFacts,
  redemptionFacts,
  vaultPaymentFacts,
  type Fact,
} from "../read";
import { withUtc } from "./utc";

export const TX_ENV = "NABLAZ_TX";
export const txEnabled = (env: Record<string, string | undefined> = process.env) => env[TX_ENV] === "on";

export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** The tables the door searches by (chain_id, tx_hash): every table whose rows GET /read renders without a chain read. */
export const TX_SEARCHED = ["record_entries", "vault_payments", "external_permissions", "external_payments", "external_redemptions", "credit_line_events"] as const;

/** On every answer past the flag: what was searched, and what the door does not render. */
export const TX_SCOPE_NOTE =
  "searched: NablaZ record entries and vault payments, spend permissions and delegations (their first log), their payments and redemptions, credit-line events; ERC-8004 feedback grounding is read on the subject's own page only";

type Row = Record<string, any>;

export type TxRows = {
  records: Row[];
  vaultPayments: Row[];
  permissions: Row[];
  payments: Row[];
  redemptions: Row[];
  creditLines: Row[];
  /** The permission rows of `payments`, by external_permissions id (as GET /read). */
  paymentPermissions: Map<string, Row>;
};

/** What the door needs from the database and the chain, for one chain. */
export type TxDeps = {
  /** The chain's indexed block, or null while the indexer has no checkpoint. */
  asOfBlock: () => Promise<bigint | null>;
  /** Every searched row with this (lowercase) tx hash on the chain. */
  rows: (txHash: Hex) => Promise<TxRows>;
  /** The NablaZ label of an account at the read block, or null when it is not a NablaZ account on this chain. */
  labelOf: (account: Hex, asOfBlock: bigint) => Promise<NablaLabel | null>;
  /** The transaction's block; "pending" when it is in no block yet; null when the chain has no such transaction. Throws when the lookup fails. */
  txBlock: (txHash: Hex) => Promise<bigint | "pending" | null>;
};

/**
 * The subject column of each searched table (R-S231-8; docs/reader/s231-tx-fact-subject.md). Records, vault payments
 * and credit lines have one column GET /read selects on; permissions and payments take /feed's choice (subject, payer);
 * a redemption takes THIS HOP's delegator, the column a delegation's subject comes from, never rootDelegator
 * (R-S231-4).
 */
export const TX_SUBJECT_FIELD = {
  records: "subject",
  vaultPayments: "account",
  permissions: "subject",
  payments: "payer",
  redemptions: "delegator",
  creditLines: "party",
} as const satisfies Record<Exclude<keyof TxRows, "paymentPermissions">, string>;

export type TxSubject = { subject: Hex; subjectField: string } | { subject: null; subjectField: null; subjectReason: string };
/** A fact as the door serves it: the GET /read fact, unchanged, plus its subject. */
export type TxFact = Fact & TxSubject;

/** The subject of a cited row: `field`'s value, lower-case; null with the reason when the kind has no such column (field null) or the row lacks it. */
export function subjectOf(row: Row, field: string | null, reason?: string): TxSubject {
  if (field === null) return { subject: null, subjectField: null, subjectReason: reason ?? "this kind names no subject account" };
  const v = row[field];
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) return { subject: null, subjectField: null, subjectReason: `the cited row has no ${field} address` };
  return { subject: lc(v), subjectField: field };
}

/** Each row's one fact (every builder maps one row to one fact, src/read.ts), with that row's subject. */
function paired(rows: Row[], build: (row: Row) => Fact[], field: string | null): TxFact[] {
  return rows.map((r) => {
    const fs = build(r);
    if (fs.length !== 1) throw new Error(`a fact builder made ${fs.length} facts from one row`);
    return { ...fs[0]!, ...subjectOf(r, field) };
  });
}

export type TxAnswer = { status: 200 | 400 | 404 | 503; body: unknown };

export const NOT_READY = { ready: false } as const;

const lc = (a: string) => a.toLowerCase() as Hex;

export async function readTx(
  params: { chainId: string; txHash: string },
  x: { enabled: boolean; chainIds: number[]; deps: (chainId: number) => TxDeps },
): Promise<TxAnswer> {
  if (!x.enabled) return { status: 503, body: NOT_READY };
  const chainId = Number(params.chainId);
  if (!x.chainIds.includes(chainId)) return { status: 404, body: { error: `chain ${params.chainId} is not read here` } };
  if (!TX_HASH.test(params.txHash)) return { status: 400, body: { error: "not a transaction hash" } };
  const txHash = lc(params.txHash);
  const d = x.deps(chainId);
  const asOfBlock = await d.asOfBlock();
  if (asOfBlock === null) return { status: 503, body: { error: "indexer has no checkpoint for this chain yet" } };

  const r = await d.rows(txHash);
  // Labels as on the subject page: an account's own record entries and its vault payments carry its NablaZ label.
  const owners = [...new Set([...r.records.filter((e) => lc(e.writer) === lc(e.subject)).map((e) => lc(e.subject)), ...r.vaultPayments.map((p) => lc(p.account))])];
  const labels = new Map<string, NablaLabel | null>();
  for (const a of owners) labels.set(a, await d.labelOf(a, asOfBlock));
  const notes: string[] = [];
  for (const [a, l] of labels) if (l?.shape === "c") notes.push(`NablaZ label for ${getAddress(a)}: ${l.label} (${l.reason})`);

  const F = TX_SUBJECT_FIELD;
  const facts: TxFact[] = [
    ...paired(r.records, (e) => recordFacts([e], labels.get(lc(e.subject)) ?? null), F.records),
    ...paired(r.vaultPayments, (p) => vaultPaymentFacts([p], labels.get(lc(p.account)) ?? null), F.vaultPayments),
    ...paired(r.permissions, (p) => permissionFacts([p]), F.permissions),
    ...paired(r.payments, (p) => paymentFacts([p], r.paymentPermissions), F.payments),
    ...paired(r.redemptions, (d) => redemptionFacts([d]), F.redemptions),
    ...paired(r.creditLines, (c) => creditLineFacts([c]), F.creditLines),
  ].sort((a, b) => (BigInt(a.cite.block) === BigInt(b.cite.block) ? a.cite.logIndex - b.cite.logIndex : BigInt(a.cite.block) < BigInt(b.cite.block) ? -1 : 1));

  if (facts.length) {
    notes.push(TX_SCOPE_NOTE, ...notDeterminableNotes(facts));
    return { status: 200, body: { txHash, chainId, asOfBlock: asOfBlock.toString(), facts: withUtc(facts), notes } };
  }

  const base = { txHash, chainId, asOfBlock: asOfBlock.toString(), notes: [TX_SCOPE_NOTE] };
  let block: bigint | "pending" | null;
  try {
    block = await d.txBlock(txHash);
  } catch {
    return {
      status: 404,
      body: { error: `the record holds no fact anchored by tx ${txHash}; whether chain ${chainId} has it above the indexed block is not determinable (chain lookup failed)`, reason: "not-determinable", txBlock: null, ...base },
    };
  }
  if (block === null) return { status: 404, body: { error: `chain ${chainId} has no transaction ${txHash}`, reason: "unknown-hash", txBlock: null, ...base } };
  if (block === "pending") return { status: 404, body: { error: `tx ${txHash} is pending, in no block yet`, reason: "not-indexed", txBlock: null, ...base } };
  if (block > asOfBlock)
    return { status: 404, body: { error: `tx ${txHash} is at block ${block}; chain ${chainId} is indexed up to ${asOfBlock}`, reason: "not-indexed", txBlock: block.toString(), ...base } };
  return { status: 404, body: { error: `the record holds no fact anchored by tx ${txHash} (block ${block}, indexed up to ${asOfBlock})`, reason: "no-fact", txBlock: block.toString(), ...base } };
}
