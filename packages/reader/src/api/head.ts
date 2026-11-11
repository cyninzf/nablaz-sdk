// The readiness head gate (S213 B1). Ponder's own /ready turns 200 once the historical backfill is done
// (is_ready = 1), which on S211's resume was about 4.5 min before the index reached the chain head. GET /ready/head
// (src/api/index.ts) answers 200 only when Ponder is ready AND every enabled chain's indexed block is current with
// that chain's head; the front relays it as the public /ready and gates /read, /feed and the MCP tool on it.
//
// "Current": the chain-time lag between the head and the indexed block is at most HEAD_TOLERANCE_SECONDS. The head
// is read with eth_getBlockByNumber("latest", false) on the indexer's transport, cached per chain and refreshed no
// more often than HEAD_REFRESH_MS, one call in flight per chain: a readiness request never triggers more than that.
// Between refreshes the cached head's timestamp is carried forward by the wall-clock time since it was read (both
// chains produce blocks continuously), so a stale cache cannot make a lagging index look current. If a refresh
// fails, the last head read within HEAD_STALE_MS is used the same way; with none, the chain is not current.
// Lag is measured in chain time, so a per-chain block time is never assumed (Base's is 0.2 s, not 2 s: S213 A1).
// A bounded index (READER_END_BLOCK, the tests' fixed windows) is current once it has indexed its end block: its
// target is that block, not the chain head, and no head is read for it. The hosted reader sets no end block.

/** Largest head-to-indexed lag, in seconds of chain time, at which a chain counts as current. */
export const HEAD_TOLERANCE_SECONDS = 15;
/** A chain's cached head is read again no sooner than this. */
export const HEAD_REFRESH_MS = 10_000;
/** After a failed refresh, a head read up to this long ago is still used (carried forward). */
export const HEAD_STALE_MS = 60_000;

export type HeadBlock = { number: bigint; timestamp: bigint };
export type IndexedBlock = { number: number; timestamp: number };

export type ChainLag =
  | { chain: string; current: true; lagSeconds: number }
  | { chain: string; current: false; lagSeconds: number | null; reason: string };

/**
 * One chain's comparison: `lagSeconds` is the head's timestamp, carried forward by `sinceReadMs`, minus
 * the indexed block's timestamp (never below 0).
 */
export function chainLag(chain: string, indexed: IndexedBlock | undefined, head: { block: HeadBlock; sinceReadMs: number } | null, tolerance = HEAD_TOLERANCE_SECONDS): ChainLag {
  if (!indexed) return { chain, current: false, lagSeconds: null, reason: "no checkpoint for this chain" };
  if (!head) return { chain, current: false, lagSeconds: null, reason: "chain head not read" };
  const headNow = Number(head.block.timestamp) + Math.max(0, head.sinceReadMs) / 1000;
  const lag = Math.max(0, Math.round((headNow - indexed.timestamp) * 10) / 10);
  if (indexed.number >= Number(head.block.number) || lag <= tolerance) return { chain, current: true, lagSeconds: lag };
  return { chain, current: false, lagSeconds: lag, reason: `indexed block ${indexed.number} is ${lag} s behind the chain head (tolerance ${tolerance} s)` };
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
