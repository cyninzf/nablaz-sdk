// S213 B1 / R-S232-2: the readiness head gate (src/api/head.ts): the omnichain-frontier rule and its stall detector,
// the bounded-index rule, and the cached head
// (refreshed no more often than every HEAD_REFRESH_MS, one call in flight per chain, a failed refresh falling back
// to a head read within HEAD_STALE_MS).

import { describe, expect, it } from "vitest";
import { HEAD_REFRESH_MS, HEAD_STALE_MS, HEAD_STALL_SECONDS, HEAD_TOLERANCE_SECONDS, boundedLag, endBlockOf, frontierLags, headCache, omnichainFrontier, type ChainHead, type HeadBlock } from "../../src/api/head";

const head = (number: number, timestamp: number, sinceReadMs = 0) => ({ block: { number: BigInt(number), timestamp: BigInt(timestamp) }, sinceReadMs });

const T0 = 1_795_700_000; // a chain-time origin, seconds
const at = (chain: string, indexed: [number, number] | undefined, h: [number, number, number?] | null): ChainHead => ({
  chain,
  indexed: indexed && { number: indexed[0], timestamp: indexed[1] },
  head: h && head(h[0], h[1], h[2] ?? 0),
});
const ready = (lags: { current: boolean }[]) => lags.every((l) => l.current);

describe("frontierLags (R-S232-2)", () => {
  it("the tolerance stays 15 s of chain time; the stall limit is 5 minutes", () => {
    expect(HEAD_TOLERANCE_SECONDS).toBe(15);
    expect(HEAD_STALL_SECONDS).toBe(300);
    expect(HEAD_REFRESH_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("the frontier is the minimum across chains of each head's timestamp, carried forward by its cache age", () => {
    expect(omnichainFrontier([at("base", [1, 0], [10, T0 + 30]), at("linea", [1, 0], [5, T0, 4_000]), at("arbitrum", [1, 0], [9, T0 + 29])])).toBe(T0 + 4);
    expect(omnichainFrontier([at("base", [1, 0], null)])).toBeNull();
  });

  it("FLAP PIN (S232 member 0): a Linea gap past 15 s is NOT a 503 when every chain sits at the frontier", () => {
    // Linea's last block is 36 s old (the measured max gap); omnichain holds every chain's checkpoint at it. The other
    // chains' heads are 36 s ahead. Under the S213 per-chain rule this read 36 s behind on four chains: 503.
    const now = (T0 + 36) * 1000;
    const chains = [
      at("linea", [32717534, T0], [32717534, T0, 5_000]),
      at("base", [62589146, T0], [62589326, T0 + 36, 2_000]),
      at("arbitrum", [527767460, T0], [527767604, T0 + 36]),
      at("optimism", [160054713, T0], [160054731, T0 + 36]),
      at("polygon", [98001820, T0 - 1], [98001838, T0 + 36]),
    ];
    const lags = frontierLags(chains, now);
    expect(ready(lags)).toBe(true);
    expect(Math.max(...lags.map((l) => l.lagSeconds ?? Infinity))).toBeLessThanOrEqual(6);
  });

  it("an index stopped behind the frontier is not current: lag past 15 s is a 503 with the reason", () => {
    const now = (T0 + 60) * 1000;
    const lags = frontierLags([at("linea", [100, T0], [104, T0 + 40]), at("base", [200, T0], [500, T0 + 60])], now);
    expect(ready(lags)).toBe(false);
    expect(lags[0]).toEqual({ chain: "linea", current: false, lagSeconds: 40, reason: "indexed block 100 is 40 s behind the omnichain frontier (tolerance 15 s)" });
    expect(lags[1]).toMatchObject({ current: false, lagSeconds: 40 });
  });

  it("current within the tolerance, not beyond it; the cache age counts against the index", () => {
    const mk = (age: number) => frontierLags([at("base", [100, T0], [110, T0 + 1, age]), at("arbitrum", [200, T0], [204, T0 + 1, age])], (T0 + 1) * 1000 + age);
    expect(ready(mk(0))).toBe(true);
    expect(ready(mk(14_000))).toBe(true);
    expect(mk(20_000)[0]).toMatchObject({ current: false, lagSeconds: 21 });
  });

  it("STALL DETECTOR: a head older than 5 minutes at read time is never current, even when the index is at it", () => {
    // Linea's leg stops advancing: its head freezes at T0 and holds the frontier there, so every lag reads 0.
    const now = (T0 + HEAD_STALL_SECONDS + 1) * 1000;
    const lags = frontierLags([at("linea", [100, T0], [100, T0]), at("base", [200, T0], [900, T0 + HEAD_STALL_SECONDS])], now);
    expect(ready(lags)).toBe(false);
    expect(lags[0]).toEqual({ chain: "linea", current: false, lagSeconds: null, reason: `chain head 100 is ${HEAD_STALL_SECONDS + 1} s old (stall limit ${HEAD_STALL_SECONDS} s)` });
    // At exactly the limit it is not yet a stall.
    expect(ready(frontierLags([at("linea", [100, T0], [100, T0])], (T0 + HEAD_STALL_SECONDS) * 1000))).toBe(true);
  });

  it("an index at or past its head is current; no checkpoint or no head is not, and no head is not a frontier", () => {
    const now = (T0 + 10) * 1000;
    expect(frontierLags([at("base", [120, T0 - 100], [110, T0 - 100]), at("arbitrum", [5, T0 + 9], [5, T0 + 9])], now)[0]).toMatchObject({ current: true });
    expect(frontierLags([at("base", undefined, [1, T0])], now)[0]).toEqual({ chain: "base", current: false, lagSeconds: null, reason: "no checkpoint for this chain" });
    const noHead = frontierLags([at("base", [1, T0], null), at("arbitrum", [5, T0], [5, T0])], now);
    expect(noHead[0]).toEqual({ chain: "base", current: false, lagSeconds: null, reason: "chain head not read" });
    expect(ready(noHead)).toBe(false);
  });
});

describe("bounded index (READER_END_BLOCK)", () => {
  it("current once the indexed block reaches the end block; no head is involved", () => {
    expect(boundedLag("base", { number: 500, timestamp: 1 }, 500)).toEqual({ chain: "base", current: true, lagSeconds: 0 });
    expect(boundedLag("base", { number: 499, timestamp: 1 }, 500)).toMatchObject({ current: false, reason: "indexed block 499 is below the end block 500" });
    expect(boundedLag("base", undefined, 500)).toMatchObject({ current: false });
  });
  it("READER_END_BLOCK is read as ponder.config.ts reads it", () => {
    expect(endBlockOf({})).toBeUndefined();
    expect(endBlockOf({ READER_END_BLOCK: "" })).toBeUndefined();
    expect(endBlockOf({ READER_END_BLOCK: "53160200" })).toBe(53_160_200);
  });
});

describe("headCache", () => {
  const setup = () => {
    let t = 1_000_000;
    let n = 0;
    let fail = false;
    const calls: string[] = [];
    const cache = headCache(
      async (chain): Promise<HeadBlock> => {
        calls.push(chain);
        await new Promise((r) => setTimeout(r, 5));
        if (fail) throw new Error("rpc down");
        n++;
        return { number: BigInt(n), timestamp: BigInt(n) };
      },
      () => t,
    );
    return { cache, calls, tick: (ms: number) => (t += ms), setFail: (f: boolean) => (fail = f) };
  };

  it("reads once per chain per HEAD_REFRESH_MS, however many requests ask; concurrent requests share the read", async () => {
    const s = setup();
    const many = await Promise.all(Array.from({ length: 50 }, () => s.cache.head("base")));
    expect(s.calls).toEqual(["base"]);
    expect(new Set(many.map((h) => h!.block.number))).toEqual(new Set([1n]));
    s.tick(HEAD_REFRESH_MS - 1);
    await s.cache.head("base");
    expect(s.calls).toEqual(["base"]);
    expect((await s.cache.head("base"))!.sinceReadMs).toBe(HEAD_REFRESH_MS - 1);
    s.tick(1);
    expect((await s.cache.head("base"))!.block.number).toBe(2n);
    expect(s.calls).toEqual(["base", "base"]);
    await s.cache.head("arbitrum");
    expect(s.calls).toEqual(["base", "base", "arbitrum"]);
  });

  it("a failed refresh keeps the last head while it is within HEAD_STALE_MS, aged; then none; no retry storm", async () => {
    const s = setup();
    await s.cache.head("base");
    s.setFail(true);
    s.tick(HEAD_REFRESH_MS);
    expect(await s.cache.head("base")).toEqual({ block: { number: 1n, timestamp: 1n }, sinceReadMs: HEAD_REFRESH_MS });
    await s.cache.head("base");
    expect(s.calls).toHaveLength(2); // the failed attempt is not retried before HEAD_REFRESH_MS
    s.tick(HEAD_STALE_MS);
    expect(await s.cache.head("base")).toBeNull();
    s.setFail(false);
    s.tick(HEAD_REFRESH_MS);
    expect((await s.cache.head("base"))!.block.number).toBe(2n);
  });
});
