// Exit, not idle, on database loss (S211). Ponder 0.18.1 logs and swallows Postgres pool, client and heartbeat
// errors (utils/pg.js, database/index.js), so a lost database can leave the process up with nothing advancing.
// Ponder's own heartbeat (_ponder_meta 'app'.heartbeat_at) is written every 10 s by its indexer: when the newest
// one read is older than STALE_MS, whether the read fails, hangs or returns an old value, the process exits 75
// (Ponder's retryable code) and scripts/reader-start.sh ends the machine's start, so Fly restarts it.
// In src/api/, which Ponder leaves out of the build id.

export const STALE_MS = 120_000;
/** The heartbeat read, schema-qualified (the api pool's search_path is not relied on). */
export const heartbeatSql = (schema: string) =>
  `select (value->>'heartbeat_at')::bigint as h from "${schema.replace(/"/g, '""')}"._ponder_meta where key = 'app'`;
export const PROBE_MS = 15_000;

type Opts = { staleMs?: number; probeMs?: number; now?: () => number; exit?: (code: number) => void; log?: (m: string) => void };

/** One check: reads the heartbeat (ms epoch); exits when the newest heartbeat seen is older than staleMs. */
export function dbWatchdog(readHeartbeat: () => Promise<number>, o: Opts = {}): () => Promise<void> {
  const { staleMs = STALE_MS, probeMs = PROBE_MS, now = Date.now, exit = (c) => process.exit(c), log = console.error } = o;
  // Starts at load: Ponder runs this module after its migrate, which already writes heartbeats every 10 s.
  let newest = now();
  return async () => {
    const hb = await Promise.race([readHeartbeat(), new Promise<number>((_, no) => setTimeout(() => no(new Error("timeout")), probeMs).unref())]).catch(() => NaN);
    if (Number.isFinite(hb) && hb > newest) newest = hb;
    const age = now() - newest;
    if (age > staleMs) {
      log(`db watchdog FATAL: no Ponder heartbeat for ${Math.round(age / 1000)} s (limit ${staleMs / 1000} s); the database is lost or Ponder's writer is stalled; exiting 75`);
      exit(75);
    }
  };
}
