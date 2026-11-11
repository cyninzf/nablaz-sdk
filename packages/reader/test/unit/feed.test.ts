// R-S213-1: GET /feed's query, cursor and items (src/api/feed.ts). The queries themselves run against served
// indexes in test/fork/external.fork.test.ts and test/fork/grounding.fork.test.ts.

import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_NOT_INDEXED,
  FEED_DEFAULT_LIMIT,
  FEED_ENV,
  FEED_MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  externalPaymentItems,
  feedEnabled,
  keyOf,
  page,
  parseFeedQuery,
  permissionItems,
  recordItems,
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
const vpay = (b: number, l: number, ts: number, fundingEntryId: string | null) => ({ id: `v-${b}`, ...ev(42161, b, l, ts), account: A, vault: "0x01", payee: "0x02", value: 9n, token: "0x03", nonce: "0x", submitter: "0x04", transferLogIndex: l + 1, fundingEntryId, settlements: 1, settlementOrdinalInTx: 0, settlementsInTx: 1, calls: null, callsStatus: "x" });
const perm = (source: "spm" | "delegation_manager", pid: string, b: number, l: number, ts: number) => ({ id: `8453-${source === "spm" ? "spm" : "dm"}-${pid}`, ...ev(8453, b, l, ts), source, subject: A, grantee: "0x05", permissionId: pid, shape: "a", label: "(a) allowance, per period", terms: {}, status: "approved", useCount: 3 });
const xpay = (source: "spm" | "delegation_manager", pid: string | null, b: number, l: number, ts: number) => ({ id: `x-${b}-${l}`, ...ev(8453, b, l, ts), source, payer: A, payee: "0x06", token: "0x07", amount: 11n, permissionId: pid, redemptionTx: null, redemptionLogIndex: null });

describe("gate (S213-SE7)", () => {
  it("off unless NABLAZ_FEED is exactly \"on\"", () => {
    expect(FEED_ENV).toBe("NABLAZ_FEED");
    expect(feedEnabled({})).toBe(false);
    for (const v of ["", "off", "true", "1", "ON", " on"]) expect(feedEnabled({ NABLAZ_FEED: v }), v).toBe(false);
    expect(feedEnabled({ NABLAZ_FEED: "on" })).toBe(true);
  });

  it("the route answers 503 {\"ready\":false} before any query when off", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/api/index.ts", import.meta.url), "utf8");
    const route = src.slice(src.indexOf('app.get("/feed"'));
    const firstLine = route.split("\n").slice(1).find((l) => !l.trim().startsWith("//"))!;
    expect(firstLine.trim()).toBe("if (!feedEnabled()) return c.json({ ready: false }, 503);");
  });
});

describe("query", () => {
  it("limit defaults to 100, at most 500, an integer from 1", () => {
    expect([FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT]).toEqual([100, 500]);
    expect(parseFeedQuery(undefined, undefined)).toEqual({ limit: 100, before: null });
    expect(parseFeedQuery("500", undefined)).toEqual({ limit: 500, before: null });
    for (const bad of ["0", "501", "-1", "1.5", "x", "", "99999"]) expect(parseFeedQuery(bad, undefined), bad).toHaveProperty("error");
  });
  it("a cursor round-trips; anything else is refused", () => {
    const k: FeedKey = [1_700_000_000n, 8453, 53_160_100n, 7, 2];
    expect(decodeCursor(encodeCursor(k))).toEqual(k);
    expect(parseFeedQuery(undefined, encodeCursor(k))).toEqual({ limit: 100, before: k });
    for (const bad of ["", "not a cursor", "MS4yLjM", encodeCursor(k) + "=", Buffer.from("1.2.3.4.9").toString("base64url"), Buffer.from("1.2.-3.4.0").toString("base64url")]) {
      expect(parseFeedQuery(undefined, bad), bad).toHaveProperty("error");
    }
  });
});

describe("items", () => {
  it("ACCOUNT_OPENED is an account, GRANT_SET a grant, other record kinds are not in the feed; source verbatim", () => {
    const items = recordItems([record("ACCOUNT_OPENED", 10, 1, 100), record("GRANT_SET", 11, 2, 101), record("PAY_AUTHORIZED", 12, 3, 102)]);
    expect(items.map((i) => [i.kind, i.source])).toEqual([["account", "nablaz:record"], ["grant", "nablaz:record"]]);
    expect(items[0]).toEqual({
      chainId: 42161, kind: "account", subject: A.toLowerCase(), source: "nablaz:record", block: "10", logIndex: 1, timestamp: "100", timestampUtc: "1970-01-01T00:01:40Z",
      citations: [{ role: "entry", block: "10", tx: TX(10_001), logIndex: 1 }],
    });
  });

  it("a vault payment is the pair: its PAY_AUTHORIZED entry and its settlement; an unindexed authorization is not determinable", () => {
    const auth = record("PAY_AUTHORIZED", 12, 3, 102);
    const [paired, unpaired] = vaultPaymentItems([vpay(20, 4, 200, auth.id), vpay(21, 0, 201, "missing")], new Map([[auth.id, auth]]));
    expect(paired).toMatchObject({ kind: "payment", source: "nablaz:vault_payment", subject: A.toLowerCase(), block: "20", logIndex: 4 });
    expect(paired!.citations).toEqual([
      { role: "authorization", block: "12", tx: TX(12_003), logIndex: 3 },
      { role: "settlement", block: "20", tx: TX(20_004), logIndex: 4 },
    ]);
    expect(unpaired!.citations[0]).toEqual({ role: "authorization", notDeterminable: AUTHORIZATION_NOT_INDEXED });
    expect(AUTHORIZATION_NOT_INDEXED).toBe("not determinable: authorization not indexed");
  });

  it("spend-permission and delegation payments pair with their permission's first log; permissions are grants", () => {
    const p = perm("spm", "0xab", 30, 1, 300);
    const [spm, dm] = externalPaymentItems([xpay("spm", "0xAB", 31, 2, 301), xpay("delegation_manager", null, 32, 3, 302)], new Map([[p.id, p]]));
    expect(spm).toMatchObject({ kind: "payment", source: "coinbase:spend_permission_payment", chainId: 8453 });
    expect(spm!.citations).toEqual([{ role: "authorization", block: "30", tx: TX(30_001), logIndex: 1 }, { role: "settlement", block: "31", tx: TX(31_002), logIndex: 2 }]);
    expect(dm).toMatchObject({ source: "metamask:delegation_payment" });
    expect(dm!.citations[0]).toEqual({ role: "authorization", notDeterminable: AUTHORIZATION_NOT_INDEXED });
    expect(permissionItems([p, perm("delegation_manager", "0xcd", 33, 0, 303)]).map((i) => [i.kind, i.source, i.citations[0]!.role])).toEqual([
      ["grant", "coinbase:spend_permission", "permission"],
      ["grant", "metamask:delegation", "permission"],
    ]);
  });

  it("no amount, value, count or total reaches an item, though the rows carry them; no banned word either", () => {
    const auth = record("PAY_AUTHORIZED", 12, 3, 102);
    const p = perm("spm", "0xab", 30, 1, 300);
    const items = [
      ...recordItems([record("GRANT_SET", 11, 2, 101)]),
      ...vaultPaymentItems([vpay(20, 4, 200, auth.id)], new Map([[auth.id, auth]])),
      ...externalPaymentItems([xpay("spm", "0xab", 31, 2, 301)], new Map([[p.id, p]])),
      ...permissionItems([p]),
    ];
    const text = JSON.stringify(items, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toMatch(/"(amount|value|useCount|settlements|count|total)"/i);
    expect(bannedHits(text)).toEqual([]);
  });
});

describe("page", () => {
  const it3 = (chainId: number, block: number, logIndex: number, ts: number, kind: FeedItem["kind"] = "grant"): FeedItem => ({
    chainId, kind, subject: A, source: "x", block: String(block), logIndex, timestamp: String(ts), timestampUtc: null, citations: [],
  });
  const all = [it3(42161, 500, 0, 100), it3(8453, 50, 0, 101), it3(42161, 501, 2, 101), it3(42161, 501, 2, 101, "payment"), it3(8453, 49, 9, 99), it3(42161, 999, 0, 102)];
  const asOf = new Map([[42161, 600n], [8453, 60n]]);

  it("newest first by timestamp across chains; above a chain's asOfBlock is left out", () => {
    const p = page(all, { limit: 10, before: null }, asOf);
    expect(p.items.map((i) => `${i.chainId}:${i.block}:${i.kind}`)).toEqual(["42161:501:payment", "42161:501:grant", "8453:50:grant", "42161:500:grant", "8453:49:grant"]);
    expect(p.next).toBeNull();
  });

  it("walking with the cursor returns every item once, in order, including items that share a log", () => {
    const whole = page(all, { limit: 10, before: null }, asOf).items;
    const walked: FeedItem[] = [];
    let before: FeedKey | null = null;
    for (let i = 0; i < 10; i++) {
      const p = page(all, { limit: 2, before }, asOf);
      walked.push(...p.items);
      if (!p.next) break;
      before = decodeCursor(p.next);
    }
    expect(walked).toEqual(whole);
    expect(new Set(walked.map((i) => JSON.stringify(keyOf(i), (_, v) => String(v)))).size).toBe(walked.length);
  });

  it("an empty window is an empty items array and no cursor", () => {
    expect(page([], { limit: 100, before: null }, asOf)).toEqual({ items: [], next: null });
  });
});
