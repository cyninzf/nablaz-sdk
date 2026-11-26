// S233 (R-S232-8): history serving on GET /feed (src/api/feed.ts): the window AT a position (?at), the settled-history
// cache rule, and the optional settled value (?include=settledValue). Every piece is additive: the existing query,
// cursor, page and items are pinned in feed.test.ts and must read exactly as before.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  HISTORY_CACHE_CONTROL,
  HISTORY_SETTLED_SECONDS,
  attachSettledValues,
  blockBound,
  decodeCursor,
  encodeCursor,
  externalPaymentItems,
  historyCacheControl,
  page,
  parseFeedInclude,
  parseFeedPosition,
  parseFeedQuery,
  permissionItems,
  recordItems,
  settledValues,
  timeBound,
  vaultPaymentItems,
  type FeedItem,
  type FeedKey,
} from "../../src/api/feed";
import { bannedHits } from "../../lib/wording";

const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const A = "0x00000000000000000000000000000000000000AA";
const ev = (chainId: number, block: number, logIndex: number, ts: number) => ({ chainId, blockNumber: BigInt(block), blockTimestamp: BigInt(ts), txHash: TX(block * 1000 + logIndex), logIndex, reproduce: "cast", reproduceGetLogs: "{}" });
const record = (kindName: string, b: number, l: number, ts: number) => ({
  id: `42161-${b}-${l}`, ...ev(42161, b, l, ts), kindName, subject: A, writer: A, kind: "0x01", writerAuth: "0x", counterparty: "0x", counterpartyAuth: "0x", policyHash: "0x", policyVersion: 1n, asset: "0x", amount: 7n, obligationRef: "0x", seq: 1n,
});
const vpay = (b: number, l: number, ts: number, value: bigint | null, transferLogIndex: number | null) => ({ id: `v-${b}`, ...ev(42161, b, l, ts), account: A, vault: "0x01", payee: "0x02", value, token: "0x00000000000000000000000000000000000000C3", nonce: "0x", submitter: "0x04", transferLogIndex, fundingEntryId: null, settlements: 1, settlementOrdinalInTx: 0, settlementsInTx: 1, calls: null, callsStatus: "x" });
const perm = (pid: string, b: number, l: number, ts: number) => ({ id: `8453-spm-${pid}`, ...ev(8453, b, l, ts), source: "spm", subject: A, grantee: "0x05", permissionId: pid, shape: "a", label: "(a) allowance, per period", terms: {}, status: "approved", useCount: 3 });
const xpay = (source: "spm" | "delegation_manager", pid: string | null, b: number, l: number, ts: number) => ({ id: `x-${b}-${l}`, ...ev(8453, b, l, ts), source, payer: A, payee: "0x06", token: "0x00000000000000000000000000000000000000C7", amount: 11n, permissionId: pid, redemptionTx: null, redemptionLogIndex: null });

const it3 = (chainId: number, block: number, logIndex: number, ts: number, kind: FeedItem["kind"] = "grant"): FeedItem => ({
  chainId, kind, subject: A, source: "x", block: String(block), logIndex, timestamp: String(ts), timestampUtc: null, citations: [],
});
const ids = (xs: FeedItem[]) => xs.map((i) => `${i.chainId}:${i.block}:${i.logIndex}`);

describe("?at: a position (S233 2b)", () => {
  it("absent is null, and the existing query is untouched by it", () => {
    expect(parseFeedPosition(undefined, undefined)).toBeNull();
    expect(parseFeedPosition(undefined, "abc")).toBeNull();
    expect(parseFeedQuery(undefined, undefined)).toEqual({ limit: 100, before: null });
  });
  it("a time in epoch seconds or <chainId>:<block>; anything else, or with ?before, is refused", () => {
    expect(parseFeedPosition("1750000000", undefined)).toEqual({ time: 1750000000n });
    expect(parseFeedPosition("8453:123", undefined)).toEqual({ chainId: 8453, block: 123n });
    for (const bad of ["", "x", "-1", "1.5", "2026-06-01", "8453:", ":1", "8453:1:2", "1".repeat(13), "8453:x", `1:${"9".repeat(21)}`])
      expect(parseFeedPosition(bad, undefined), bad).toHaveProperty("error");
    expect(parseFeedPosition("1750000000", encodeCursor([1n, 1, 1n, 0, 0]))).toHaveProperty("error");
  });

  const all = [it3(42161, 500, 0, 100), it3(8453, 50, 0, 101), it3(42161, 501, 2, 101), it3(8453, 49, 9, 99), it3(42161, 999, 0, 102), it3(42161, 502, 0, 101)];
  const asOf = new Map([[42161, 2000n], [8453, 60n]]);

  it("at a time T: exactly the items with timestamp <= T, newest first, as a page would show them", () => {
    expect(ids(page(all, { limit: 10, before: timeBound(101n) }, asOf).items)).toEqual(["42161:502:0", "42161:501:2", "8453:50:0", "42161:500:0", "8453:49:9"]);
    expect(ids(page(all, { limit: 10, before: timeBound(100n) }, asOf).items)).toEqual(["42161:500:0", "8453:49:9"]);
    expect(page(all, { limit: 10, before: timeBound(98n) }, asOf)).toEqual({ items: [], next: null });
  });
  it("at block B of chain C: that block and everything before it in the feed's order; a later block with the same timestamp is not in it", () => {
    // 42161 blocks 501 and 502 share timestamp 101 (Arbitrum blocks can).
    expect(ids(page(all, { limit: 10, before: blockBound(101n, 42161, 501n) }, asOf).items)).toEqual(["42161:501:2", "8453:50:0", "42161:500:0", "8453:49:9"]);
    // A smaller chain id at the same timestamp precedes it in the order, so it is in the window at 42161's block.
    expect(ids(page(all, { limit: 10, before: blockBound(101n, 8453, 50n) }, asOf).items)).toEqual(["8453:50:0", "42161:500:0", "8453:49:9"]);
  });
  it("the window's nextBefore continues it as a plain /feed cursor, every item once", () => {
    const whole = page(all, { limit: 10, before: timeBound(101n) }, asOf).items;
    const walked: FeedItem[] = [];
    let before: FeedKey | null = timeBound(101n);
    for (let i = 0; i < 10; i++) {
      const p = page(all, { limit: 2, before }, asOf);
      walked.push(...p.items);
      if (!p.next) break;
      expect(parseFeedQuery(undefined, p.next)).toEqual({ limit: 100, before: decodeCursor(p.next) });
      before = decodeCursor(p.next);
    }
    expect(walked).toEqual(whole);
  });
});

describe("settled-history cache headers (S233 2a)", () => {
  const now = 2_000_000_000;
  it("the threshold is one hour; the header is one day, immutable", () => {
    expect(HISTORY_SETTLED_SECONDS).toBe(3600);
    expect(HISTORY_CACHE_CONTROL).toBe("public, max-age=86400, immutable");
  });
  it("the now-edge (no bound) is never history: no header, as before", () => {
    expect(historyCacheControl(null, now)).toBeNull();
  });
  it("a bound at least an hour old is history; a second younger is not", () => {
    const key = (ts: number): FeedKey => [BigInt(ts), 8453, 1n, 0, 0];
    expect(historyCacheControl(key(now - 3600), now)).toBe(HISTORY_CACHE_CONTROL);
    expect(historyCacheControl(key(now - 3599), now)).toBeNull();
    expect(historyCacheControl(key(now + 10), now)).toBeNull();
    // A time position T bounds at T + 1 (every item <= T).
    expect(historyCacheControl(timeBound(BigInt(now - 3601)), now)).toBe(HISTORY_CACHE_CONTROL);
    expect(historyCacheControl(timeBound(BigInt(now - 3600)), now)).toBeNull();
  });
  it("the rule is the page's bound, not its newest item: a recent cursor over an old gap is not history", () => {
    // Newest item a day old, cursor a minute old: items could still land between them.
    expect(historyCacheControl([BigInt(now - 60), 8453, 1n, 0, 0], now)).toBeNull();
  });
  it("the route sets the header only from historyCacheControl, and the front passes it through", () => {
    const src = readFileSync(new URL("../../src/api/index.ts", import.meta.url), "utf8");
    const route = src.slice(src.indexOf('app.get("/feed"'), src.indexOf("async function withActorIdentity"));
    expect(route).toContain("const cache = historyCacheControl(q.before, Date.now() / 1000);");
    expect(route.match(/cache-control/g)).toHaveLength(1);
  });
});

describe("?include=settledValue (S233 Task 3)", () => {
  it("absent: off; only settledValue may be named", () => {
    expect(parseFeedInclude(undefined)).toEqual({ settledValue: false });
    expect(parseFeedInclude("settledValue")).toEqual({ settledValue: true });
    expect(parseFeedInclude("settledValue,settledValue")).toEqual({ settledValue: true });
    for (const bad of ["", "amount", "settledvalue", "settledValue,count", ","]) expect(parseFeedInclude(bad), bad).toHaveProperty("error");
  });

  const auth = record("PAY_AUTHORIZED", 12, 3, 102);
  const p = perm("0xab", 30, 1, 300);
  const vp = [vpay(20, 4, 200, 9_000_000n, 5), vpay(21, 4, 201, null, null)];
  const xp = [xpay("spm", "0xab", 31, 2, 301), xpay("delegation_manager", "0xcd", 32, 7, 302)];
  const build = () => [
    ...recordItems([record("GRANT_SET", 11, 2, 101), auth]),
    ...vaultPaymentItems(vp, new Map([[auth.id, auth]])),
    ...externalPaymentItems(xp, new Map([[p.id, p]])),
    ...permissionItems([p]),
  ];

  it("each payment with a value gets the token's raw amount and the one log that carries it", () => {
    const items = build();
    attachSettledValues(items, settledValues(vp, xp));
    const pays = items.filter((i) => i.kind === "payment");
    expect(pays.map((i) => i.settledValue)).toEqual([
      { token: "0x00000000000000000000000000000000000000c3", value: "9000000", citation: { role: "transfer", block: "20", tx: TX(20004), logIndex: 5 } },
      undefined, // no paired Transfer: no field, citation-or-nothing
      { token: "0x00000000000000000000000000000000000000c7", value: "11", citation: { role: "settlement", block: "31", tx: TX(31002), logIndex: 2 } },
      { token: "0x00000000000000000000000000000000000000c7", value: "11", citation: { role: "settlement", block: "32", tx: TX(32007), logIndex: 7 } },
    ]);
    // An external payment's value is cited at its own settlement log, the same log as the item's settlement citation.
    for (const i of pays.slice(2)) expect(i.citations.find((c) => c.role === "settlement")).toEqual({ role: "settlement", block: i.settledValue!.citation.block, tx: i.settledValue!.citation.tx, logIndex: i.settledValue!.citation.logIndex });
    expect(items.filter((i) => i.kind !== "payment").every((i) => !("settledValue" in i))).toBe(true);
    expect(bannedHits(JSON.stringify(items))).toEqual([]);
  });
  it("not asked for: the items are exactly what they were, no value anywhere", () => {
    const items = build();
    const before = JSON.stringify(items);
    expect(before).not.toMatch(/"(amount|value|settledValue)"/);
    attachSettledValues(items, new Map());
    expect(JSON.stringify(items)).toBe(before);
  });
  it("the route attaches values only when asked", () => {
    const src = readFileSync(new URL("../../src/api/index.ts", import.meta.url), "utf8");
    expect(src).toContain("if (include.settledValue) attachSettledValues(items, settledValues(vpays, xpays));");
    expect(src.match(/attachSettledValues\(/g)).toHaveLength(1);
  });
});
