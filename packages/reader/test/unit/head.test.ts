// S213 B1: the readiness head gate (src/api/head.ts): the lag rule, the bounded-index rule, and the cached head
// (refreshed no more often than every HEAD_REFRESH_MS, one call in flight per chain, a failed refresh falling back
// to a head read within HEAD_STALE_MS).

import { describe, expect, it } from "vitest";
import { HEAD_REFRESH_MS, HEAD_STALE_MS, HEAD_TOLERANCE_SECONDS, boundedLag, chainLag, endBlockOf, headCache, type HeadBlock } from "../../src/api/head";

const head = (number: number, timestamp: number, sinceReadMs = 0) => ({ block: { number: BigInt(number), timestamp: BigInt(timestamp) }, sinceReadMs });

describe("chainLag", () => {
  it("the tolerance is seconds of chain time, not minutes", () => {
    expect(HEAD_TOLERANCE_SECONDS).toBeGreaterThanOrEqual(5);
    expect(HEAD_TOLERANCE_SECONDS).toBeLessThanOrEqual(30);
    expect(HEAD_REFRESH_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("current within the tolerance, not current beyond it, with the lag and a reason", () => {
    expect(chainLag("base", { number: 100, timestamp: 1_000 }, head(110, 1_002))).toEqual({ chain: "base", current: true, lagSeconds: 2 });
    expect(chainLag("base", { number: 100, timestamp: 1_000 }, head(200, 1_000 + HEAD_TOLERANCE_SECONDS))).toMatchObject({ current: true });
    const behind = chainLag("base", { number: 100, timestamp: 1_000 }, head(2_000, 1_270));
    expect(behind).toEqual({ chain: "base", current: false, lagSeconds: 270, reason: `indexed block 100 is 270 s behind the chain head (tolerance ${HEAD_TOLERANCE_SECONDS} s)` });
  });

  it("a cached head is carried forward by its age: an index that stopped while the cache aged is not current", () => {
    // Head read 1 s after the indexed block; 20 s later the index has not moved.
    expect(chainLag("arbitrum", { number: 100, timestamp: 1_000 }, head(104, 1_001, 0))).toMatchObject({ current: true });
    expect(chainLag("arbitrum", { number: 100, timestamp: 1_000 }, head(104, 1_001, 20_000))).toMatchObject({ current: false, lagSeconds: 21 });
  });

  it("an index at or past the cached head is current; no checkpoint or no head is not", () => {
    expect(chainLag("base", { number: 120, timestamp: 1_000 }, head(110, 900, 300_000))).toMatchObject({ current: true });
    expect(chainLag("base", undefined, head(1, 1))).toEqual({ chain: "base", current: false, lagSeconds: null, reason: "no checkpoint for this chain" });
    expect(chainLag("base", { number: 1, timestamp: 1 }, null)).toEqual({ chain: "base", current: false, lagSeconds: null, reason: "chain head not read" });
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
