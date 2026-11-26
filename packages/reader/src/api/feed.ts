// GET /feed (Live Sky, R-S213-1): the most recent indexed facts across every enabled chain, newest first, from the existing
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
// Order: (timestamp, chainId, block, logIndex, kind) descending; timestamps make the chains' blocks comparable.
// Polygon (R-S221-8) adds delegation grants and payments under chainId 137; the kinds are unchanged.
// The cursor (`before`) is that key of the last item served, base64url-encoded; it is opaque to callers.

import type { Hex } from "viem";
import { NOT_DETERMINABLE, paymentFacts, permissionFacts, recordFacts, vaultPaymentFacts } from "../read";
import { utcOf } from "./utc";
import type { ActorIdentity } from "./actor-identity";

export const FEED_DEFAULT_LIMIT = 100;
export const FEED_MAX_LIMIT = 500;
/** Record kinds the feed carries, and the feed kind each maps to. */
export const FEED_RECORD_KINDS = { ACCOUNT_OPENED: "account", GRANT_SET: "grant" } as const;
export const AUTHORIZATION_NOT_INDEXED = `${NOT_DETERMINABLE}: authorization not indexed`;

/**
 * S213-SE7: the feed is OFF unless FEED_ENV is exactly "on"; off, every /feed request answers 503 {"ready":false} at
 * once and issues no database statement (R-S202-4's logic: the door is not ready). Its queries read the *_feed index
 * (block_timestamp, chain_id, block_number, log_index; R-S215-4), which the schema event (S216) built; the production
 * EXPLAIN passed under R-S217-1 before the flag was set.
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
  /**
   * β (S222): payment items only, and only when the payer was bound to an ERC-8004 agentId at the payment's block
   * (src/api/actor-identity.ts). Additive and optional: an item without it reads as before.
   */
  actorIdentity?: ActorIdentity;
  /** S233: payment items only, and only when the request asked for it (?include=settledValue). Additive and optional. */
  settledValue?: SettledValue;
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

// ── History serving (S233, R-S232-8): the record grows without bound, so the site pages it back and jumps into it ──
// Everything below is additive and optional: a request without `at` or `include` is served exactly as before, byte
// for byte, and an item without `settledValue` reads as before.

/**
 * A /feed page whose UPPER BOUND (its `before` cursor, or its `at` position) is at least this many seconds older than
 * the wall clock is settled history. Every item it can ever hold has a timestamp before the bound, which is set by the
 * request, not by what was found under it. Ponder treats a block as final once it is 180 s older than its chain head
 * (DEFAULT_REORG_WINDOW in ponder/src/utils/finality.ts; ponder.config.ts sets no reorgWindow, and Ponder refuses one
 * above 600 s), and the head gate keeps every served chain within 15 s (+12 s grace) of the omnichain frontier
 * (src/api/head.ts), so under the gate the window below the bound can no longer change. One hour is 20× the reorg
 * window and 6× the largest one Ponder allows. The page with no bound (the now-edge) is never history.
 */
export const HISTORY_SETTLED_SECONDS = 3600;
/**
 * History-grade cache headers. One day, not a year: a reindex-class deploy that joins a chain or a source (S230) adds
 * facts to past windows, and a day bounds how long a cache serves the window from before it. `immutable`: inside that
 * day the bytes of the items never change, so a cache need not revalidate. The body's asOfBlock is the block the page was
 * read at, true of that reading.
 */
export const HISTORY_CACHE_CONTROL = "public, max-age=86400, immutable";

/** HISTORY_CACHE_CONTROL for a page whose upper bound is settled history (above); null (no header, as before) else. */
export function historyCacheControl(bound: FeedKey | null, nowSeconds: number): string | null {
  return bound !== null && bound[0] + BigInt(HISTORY_SETTLED_SECONDS) <= BigInt(Math.floor(nowSeconds)) ? HISTORY_CACHE_CONTROL : null;
}

/** A position in the record: a time (UTC epoch seconds) or a block of one chain. */
export type FeedPosition = { time: bigint } | { chainId: number; block: bigint };

/**
 * ?at: `<epoch seconds>` or `<chainId>:<block>`. Absent: null. With ?before: an error (a window is continued by its
 * own nextBefore, which is a plain /feed cursor).
 */
export function parseFeedPosition(at: string | undefined, before: string | undefined): FeedPosition | null | { error: string } {
  if (at === undefined) return null;
  if (before !== undefined) return { error: "at and before cannot both be given; continue a window with its nextBefore" };
  if (/^\d{1,12}$/.test(at)) return { time: BigInt(at) };
  const m = /^(\d{1,10}):(\d{1,20})$/.exec(at);
  if (m && Number.isSafeInteger(Number(m[1]))) return { chainId: Number(m[1]), block: BigInt(m[2]!) };
  return { error: "at must be a time in UTC epoch seconds or <chainId>:<block>" };
}

/**
 * The cursor key a position stands for: every item at or before it, newest first, is the window AT it.
 * At a time T: every item with timestamp <= T. At block B of chain C (timestamp ts): every item before
 * (ts, C, B + 1), i.e. block B of C and all that precedes it in the feed's order.
 */
export const timeBound = (t: bigint): FeedKey => [t + 1n, 0, 0n, 0, 0];
export const blockBound = (timestamp: bigint, chainId: number, block: bigint): FeedKey => [timestamp, chainId, block + 1n, 0, 0];

/** ?include: a comma-separated list of optional item fields. Only `settledValue` exists. */
export const FEED_INCLUDES = ["settledValue"] as const;
export function parseFeedInclude(include: string | undefined): { settledValue: boolean } | { error: string } {
  if (include === undefined) return { settledValue: false };
  const xs = include.split(",");
  if (!xs.every((x) => (FEED_INCLUDES as readonly string[]).includes(x))) return { error: `include may name only ${FEED_INCLUDES.join(", ")}` };
  return { settledValue: true };
}

/**
 * S233 Task 3: a payment's settled value, from the already-indexed settlement rows (no new indexing). The token's raw
 * integer amount (no decimals applied: decimals are not indexed) and the one log that carries it, citation-or-nothing:
 * - NablaZ vault payment: the ERC-20 Transfer(vault → payee) paired to the AuthorizationUsed (vault_payments.value at
 *   transferLogIndex, same tx and block). No paired Transfer (value null): no field.
 * - Spend-permission payment: SpendPermissionUsed's periodSpend.spend, the item's own settlement log.
 * - Delegation payment: the ERC-20 Transfer from the delegator, the item's own settlement log.
 */
export type SettledValue = { token: Hex; value: string; citation: { role: "transfer" | "settlement"; block: string; tx: Hex; logIndex: number } };

const settlementKey = (chainId: number, block: string, logIndex: number) => `${chainId}:${block}:${logIndex}`;

/** Settled values by the settlement log of the payment item they belong to. */
export function settledValues(vaultPaymentRows: Row[], externalPaymentRows: Row[]): Map<string, SettledValue> {
  const out = new Map<string, SettledValue>();
  for (const r of vaultPaymentRows) {
    if (r.value === null || r.value === undefined || r.transferLogIndex === null || r.transferLogIndex === undefined) continue;
    out.set(settlementKey(r.chainId, String(r.blockNumber), r.logIndex), {
      token: String(r.token).toLowerCase() as Hex,
      value: String(r.value),
      citation: { role: "transfer", block: String(r.blockNumber), tx: r.txHash as Hex, logIndex: r.transferLogIndex },
    });
  }
  for (const r of externalPaymentRows) {
    if (r.amount === null || r.amount === undefined) continue;
    out.set(settlementKey(r.chainId, String(r.blockNumber), r.logIndex), {
      token: String(r.token).toLowerCase() as Hex,
      value: String(r.amount),
      citation: { role: "settlement", block: String(r.blockNumber), tx: r.txHash as Hex, logIndex: r.logIndex },
    });
  }
  return out;
}

/** Sets settledValue on each payment item that has one (in place); every other item is untouched. */
export function attachSettledValues(items: FeedItem[], values: Map<string, SettledValue>): void {
  for (const i of items) {
    if (i.kind !== "payment") continue;
    const v = values.get(settlementKey(i.chainId, i.block, i.logIndex));
    if (v) i.settledValue = v;
  }
}
