// The readiness head gate (S213 B1). Ponder's own /ready turns 200 once the historical backfill is done
// (is_ready = 1), which on S211's resume was about 4.5 min before the index reached the chain head. GET /ready/head
// (src/api/index.ts) answers 200 only when Ponder is ready AND every enabled chain's indexed block is current with
// the omnichain frontier (below, R-S232-2); the front relays it as the public /ready and gates /read, /feed and the MCP tool on it.
//
// "Current" (R-S232-2, S232): the hosted config orders events omnichain (ponder.config.ts `ordering`), so Ponder
// never indexes past the OMNICHAIN FRONTIER: the minimum, across chains, of each chain's latest head timestamp. A
// chain whose blocks come irregularly (Linea: gaps up to 36 s measured S232) holds every chain's checkpoint at its own
// last block; measured against each chain's own head (the S213 rule) that read as every other chain >15 s behind, and
// /ready flapped (S232 member 0: 27-29% 503). A chain is current when the frontier minus its indexed block's timestamp
// is at most HEAD_TOLERANCE_SECONDS, or its indexed block is at or past its head.
//
// The head is read with eth_getBlockByNumber("latest", false) on the indexer's transport, cached per chain and
// refreshed no more often than HEAD_REFRESH_MS, one call in flight per chain: a readiness request never triggers more
// than that. Each cached head's timestamp is carried forward by the wall-clock time since it was read before the
// minimum is taken, so a stale cache cannot make a lagging index look current. If a refresh fails, the last head read
// within HEAD_STALE_MS is used the same way; with none, the chain is not current.
//
// Stall detector: a chain whose head block timestamp (as reported, not carried forward) is older than
// HEAD_STALL_SECONDS at read time is NOT current, whatever its lag: a leg that stops advancing would otherwise freeze
// the frontier and make a stopped index read as current.
// Lag is measured in chain time, so a per-chain block time is never assumed (Base's is 0.2 s, not 2 s: S213 A1).
// A bounded index (READER_END_BLOCK, the tests' fixed windows) is current once it has indexed its end block: its
// target is that block, not the chain head, and no head is read for it. The hosted reader sets no end block.

/** Largest frontier-to-indexed lag, in seconds of chain time, at which a chain counts as current. */
export const HEAD_TOLERANCE_SECONDS = 15;
/** A chain head whose block timestamp is older than this at read time is a stalled leg: never current. */
export const HEAD_STALL_SECONDS = 300;
/** A chain's cached head is read again no sooner than this. */
export const HEAD_REFRESH_MS = 10_000;
/** After a failed refresh, a head read up to this long ago is still used (carried forward). */
export const HEAD_STALE_MS = 60_000;

export type HeadBlock = { number: bigint; timestamp: bigint };
export type IndexedBlock = { number: number; timestamp: number };
export type CachedHead = { block: HeadBlock; sinceReadMs: number };

export type ChainLag =
  | { chain: string; current: true; lagSeconds: number }
  | { chain: string; current: false; lagSeconds: number | null; reason: string };

/** One chain's input to the frontier gate: its indexed block (Ponder /status) and its cached head. */
export type ChainHead = { chain: string; indexed: IndexedBlock | undefined; head: CachedHead | null };

/** A cached head's timestamp carried forward by its age, in seconds. */
const carried = (h: CachedHead) => Number(h.block.timestamp) + Math.max(0, h.sinceReadMs) / 1000;

/**
 * The omnichain frontier: the minimum, across the chains whose head was read, of each head's timestamp carried
 * forward by its age. Null when no head was read.
 */
export function omnichainFrontier(chains: ChainHead[]): number | null {
  const ts = chains.flatMap((c) => (c.head ? [carried(c.head)] : []));
  return ts.length ? Math.min(...ts) : null;
}

/**
 * Every chain's comparison against the omnichain frontier (R-S232-2). `nowMs` is the wall clock, used only by the
 * stall detector. `lagSeconds` is the frontier minus the indexed block's timestamp (never below 0).
 */
export function frontierLags(chains: ChainHead[], nowMs: number, tolerance = HEAD_TOLERANCE_SECONDS, stallSeconds = HEAD_STALL_SECONDS): ChainLag[] {
  const frontier = omnichainFrontier(chains);
  return chains.map(({ chain, indexed, head }): ChainLag => {
    if (!indexed) return { chain, current: false, lagSeconds: null, reason: "no checkpoint for this chain" };
    if (!head || frontier === null) return { chain, current: false, lagSeconds: null, reason: "chain head not read" };
    const headAge = Math.round((nowMs / 1000 - Number(head.block.timestamp)) * 10) / 10;
    if (headAge > stallSeconds) {
      return { chain, current: false, lagSeconds: null, reason: `chain head ${head.block.number} is ${headAge} s old (stall limit ${stallSeconds} s)` };
    }
    const lag = Math.max(0, Math.round((frontier - indexed.timestamp) * 10) / 10);
    if (indexed.number >= Number(head.block.number) || lag <= tolerance) return { chain, current: true, lagSeconds: lag };
    return { chain, current: false, lagSeconds: lag, reason: `indexed block ${indexed.number} is ${lag} s behind the omnichain frontier (tolerance ${tolerance} s)` };
  });
}

/** A bounded index's chain: current once its indexed block has reached `endBlock`. */
export function boundedLag(chain: string, indexed: IndexedBlock | undefined, endBlock: number): ChainLag {
  if (!indexed) return { chain, current: false, lagSeconds: null, reason: "no checkpoint for this chain" };
  if (indexed.number >= endBlock) return { chain, current: true, lagSeconds: 0 };
  return { chain, current: false, lagSeconds: null, reason: `indexed block ${indexed.number} is below the end block ${endBlock}` };
}

/** READER_END_BLOCK as ponder.config.ts reads it: undefined when unset or empty. */
export function endBlockOf(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const v = env.READER_END_BLOCK;
  return v === undefined || v === "" ? undefined : Number(v);
}

type Entry = { block: HeadBlock; readAt: number } | null;

/**
 * Per-chain cached heads. `read(chain)` is the RPC call; `now` the clock (tests). `head(chain)` returns the cached
 * head with its age, refreshing it first when it is older than HEAD_REFRESH_MS; concurrent callers share one refresh.
 */
export function headCache(read: (chain: string) => Promise<HeadBlock>, now: () => number = Date.now, opts: { refreshMs?: number; staleMs?: number; onError?: (chain: string, e: unknown) => void } = {}) {
  const refreshMs = opts.refreshMs ?? HEAD_REFRESH_MS;
  const staleMs = opts.staleMs ?? HEAD_STALE_MS;
  const entries = new Map<string, Entry>();
  const attempted = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();

  const refresh = (chain: string): Promise<void> => {
    let p = inflight.get(chain);
    if (!p) {
      attempted.set(chain, now());
      p = read(chain)
        .then((block) => void entries.set(chain, { block, readAt: now() }))
        .catch((e) => opts.onError?.(chain, e))
        .finally(() => inflight.delete(chain));
      inflight.set(chain, p);
    }
    return p;
  };

  return {
    async head(chain: string): Promise<{ block: HeadBlock; sinceReadMs: number } | null> {
      const last = attempted.get(chain);
      if (last === undefined || now() - last >= refreshMs) await refresh(chain);
      else if (inflight.has(chain)) await inflight.get(chain);
      const e = entries.get(chain);
      if (!e) return null;
      const age = now() - e.readAt;
      return age <= Math.max(staleMs, refreshMs) ? { block: e.block, sinceReadMs: age } : null;
    },
  };
}
