// GET /feed (Live Sky, R-S213-1): the most recent indexed facts across both chains, newest first, from the existing
// tables only (src/api/index.ts runs the queries; this file holds the query parsing, the cursor and the items).
//
// Kinds:
// - payment: the PAIR (R-S187-1). The settlement row is the item; its authorization is cited beside it. A NablaZ
//   vault payment's authorization is its PAY_AUTHORIZED record entry (fundingEntryId); a spend-permission or
//   delegation payment's is the log that first named its permission object (the external_permissions row). An
//   authorization that is not indexed is cited as not determinable, never omitted.
// - grant: a NablaZ GRANT_SET record entry, or a spend permission / delegation (external_permissions).
// - account: a NablaZ account's first appearance on the record, its ACCOUNT_OPENED entry.
// Every item: chainId, kind, subject, source (verbatim from the fact builders in src/read.ts), block, logIndex,
// timestamp (epoch seconds) and timestampUtc (R-S205-5), and its citations. No amount field, and no count or
// total anywhere in the response.
//
// Order: (timestamp, chainId, block, logIndex, kind) descending; timestamps make the two chains' blocks comparable.
// The cursor (`before`) is that key of the last item served, base64url-encoded; it is opaque to callers.

import type { Hex } from "viem";
import { NOT_DETERMINABLE, paymentFacts, permissionFacts, recordFacts, vaultPaymentFacts } from "../read";
import { utcOf } from "./utc";

export const FEED_DEFAULT_LIMIT = 100;
export const FEED_MAX_LIMIT = 500;
/** Record kinds the feed carries, and the feed kind each maps to. */
export const FEED_RECORD_KINDS = { ACCOUNT_OPENED: "account", GRANT_SET: "grant" } as const;
export const AUTHORIZATION_NOT_INDEXED = `${NOT_DETERMINABLE}: authorization not indexed`;

/**
 * S213-SE7: the feed is OFF unless FEED_ENV is exactly "on". Its queries need the *_feed index
 * (block_timestamp, chain_id, block_number, log_index; R-S215-4) that the live schema does not have yet (it lands at
 * the next schema deploy); until then every /feed request answers 503
 * {"ready":false} at once and issues no database statement (R-S202-4's logic: the door is not ready).
 */
export const FEED_ENV = "NABLAZ_FEED";
export const feedEnabled = (env: Record<string, string | undefined> = process.env) => env[FEED_ENV] === "on";

export type FeedKind = "account" | "grant" | "payment";
const KIND_RANK: Record<FeedKind, number> = { account: 0, grant: 1, payment: 2 };

export type FeedCitation =
  | { role: "authorization" | "settlement" | "entry" | "permission"; block: string; tx: Hex; logIndex: number }
  | { role: "authorization"; notDeterminable: string };

export type FeedItem = {
  chainId: number;
  kind: FeedKind;
  subject: string;
  source: string;
  block: string;
  logIndex: number;
  timestamp: string;
  timestampUtc: string | null;
  citations: FeedCitation[];
};

/** The order key: (timestamp, chainId, block, logIndex, kind rank). */
export type FeedKey = [bigint, number, bigint, number, number];

export const keyOf = (i: FeedItem): FeedKey => [BigInt(i.timestamp), i.chainId, BigInt(i.block), i.logIndex, KIND_RANK[i.kind]];

/** -1, 0, 1 as a sorts before, with, after b in ascending key order. */
export function compareKeys(a: FeedKey, b: FeedKey): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export function encodeCursor(k: FeedKey): string {
  return Buffer.from(k.map(String).join("."), "utf8").toString("base64url");
}

export function decodeCursor(s: string): FeedKey | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) return null;
  const parts = Buffer.from(s, "base64url").toString("utf8").split(".");
  if (parts.length !== 5 || !parts.every((p) => /^\d{1,78}$/.test(p))) return null;
  const [ts, chain, block, logIndex, rank] = parts;
  const n = (x: string) => (Number.isSafeInteger(Number(x)) ? Number(x) : NaN);
  const k: FeedKey = [BigInt(ts!), n(chain!), BigInt(block!), n(logIndex!), n(rank!)];
  if ([k[1], k[3], k[4]].some((x) => Number.isNaN(x)) || k[4] > 2) return null;
  return k;
}

export type FeedQuery = { limit: number; before: FeedKey | null };

/** ?limit (1..FEED_MAX_LIMIT, default FEED_DEFAULT_LIMIT) and ?before (a cursor from a previous page). */
export function parseFeedQuery(limit: string | undefined, before: string | undefined): FeedQuery | { error: string } {
  let l = FEED_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > FEED_MAX_LIMIT) return { error: `limit must be an integer from 1 to ${FEED_MAX_LIMIT}` };
    l = Number(limit);
  }
  if (before === undefined) return { limit: l, before: null };
  const k = decodeCursor(before);
  return k ? { limit: l, before: k } : { error: "before is not a cursor this feed issued" };
}

type Row = Record<string, any>;

const evidenceCite = (role: "authorization" | "settlement" | "entry" | "permission", r: Row): FeedCitation => ({
  role,
  block: String(r.blockNumber),
  tx: r.txHash as Hex,
  logIndex: r.logIndex as number,
});

function item(kind: FeedKind, r: Row, subject: string, source: string, citations: FeedCitation[]): FeedItem {
  return {
    chainId: r.chainId,
    kind,
    subject: subject.toLowerCase(),
    source,
    block: String(r.blockNumber),
    logIndex: r.logIndex,
    timestamp: String(r.blockTimestamp),
    timestampUtc: utcOf(r.blockTimestamp),
    citations,
  };
}

/** ACCOUNT_OPENED and GRANT_SET record entries. The source comes from recordFacts. */
export function recordItems(rows: Row[]): FeedItem[] {
  const sources = recordFacts(rows, null).map((f) => f.source);
  return rows.flatMap((r, i) => {
    const kind = FEED_RECORD_KINDS[r.kindName as keyof typeof FEED_RECORD_KINDS];
    return kind ? [item(kind, r, r.subject, sources[i]!, [evidenceCite("entry", r)])] : [];
  });
}

/** Spend permissions and delegations: grants. The source comes from permissionFacts. */
export function permissionItems(rows: Row[]): FeedItem[] {
  const sources = permissionFacts(rows).map((f) => f.source);
  return rows.map((r, i) => item("grant", r, r.subject, sources[i]!, [evidenceCite("permission", r)]));
}

/** NablaZ vault payments, each paired with its PAY_AUTHORIZED entry (`entries` by record_entries.id). */
export function vaultPaymentItems(rows: Row[], entries: Map<string, Row>): FeedItem[] {
  const sources = vaultPaymentFacts(rows, null).map((f) => f.source);
  return rows.map((r, i) => {
    const auth = r.fundingEntryId ? entries.get(r.fundingEntryId) : undefined;
    return item("payment", r, r.account, sources[i]!, [
      auth ? evidenceCite("authorization", auth) : { role: "authorization", notDeterminable: AUTHORIZATION_NOT_INDEXED },
      evidenceCite("settlement", r),
    ]);
  });
}

/** The external_permissions id a payment row's permission has (the key GET /read uses). */
export const permissionIdOf = (r: Row) => (r.permissionId ? `${r.chainId}-${r.source === "spm" ? "spm" : "dm"}-${String(r.permissionId).toLowerCase()}` : null);

/** Spend-permission and delegation payments, each paired with its permission's first log (`permissions` by id). */
export function externalPaymentItems(rows: Row[], permissions: Map<string, Row>): FeedItem[] {
  const sources = paymentFacts(rows, permissions).map((f) => f.source);
  return rows.map((r, i) => {
    const id = permissionIdOf(r);
    const auth = id ? permissions.get(id) : undefined;
    return item("payment", r, r.payer, sources[i]!, [
      auth ? evidenceCite("authorization", auth) : { role: "authorization", notDeterminable: AUTHORIZATION_NOT_INDEXED },
      evidenceCite("settlement", r),
    ]);
  });
}

/**
 * One page: every item strictly before `before` (all when null) and at or below its chain's asOfBlock, newest
 * first, at most `limit`. `next` is the cursor of the page's last item when the page is full, else null.
 */
export function page(items: FeedItem[], q: FeedQuery, asOfBlock: Map<number, bigint>): { items: FeedItem[]; next: string | null } {
  const out = items
    .filter((i) => (q.before === null || compareKeys(keyOf(i), q.before) < 0) && asOfBlock.has(i.chainId) && BigInt(i.block) <= asOfBlock.get(i.chainId)!)
    .sort((a, b) => compareKeys(keyOf(b), keyOf(a)))
    .slice(0, q.limit);
  return { items: out, next: out.length === q.limit ? encodeCursor(keyOf(out.at(-1)!)) : null };
}
