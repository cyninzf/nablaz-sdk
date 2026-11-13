// P-GTM-4, the outside-read instrument (R-S214-11, R-S217-7): the reader's half. The front (packages/mcp/src/caller.ts)
// classifies each request at the two public read doors and sets two internal headers on its own loopback fetches to
// this reader: x-nablaz-door (read | mcp) and x-nablaz-class (the caller class). The reader counts them, in memory,
// per (door, class, stage), and serves the counters on /metrics/reader beside the RPC legs' (row E):
//   stage "attempt": a GET /ready/head carrying the headers, i.e. one read attempt at a door (every read at both
//                    doors is preceded by exactly one readiness check, whether it then reads or answers 503);
//   stage "served":  a GET /read carrying the headers that the reader answered 200.
// Population (R-S217-7): these counters cover read attempts and reads served at both doors. MCP discovery calls
// (initialize, tools/list) and 429s appear only in the front's per-request log lines. Requests without the headers
// (the public /ready, /feed, anything on loopback) are not counted; a value outside the fixed sets is ignored.
// Until the site's proxy sends x-nablaz-caller (a later web PR), site reads sit in "unclassified".
// Counters start at 0 on every process start (deploy, restart); a monthly reading is a scrape at the window's ends
// with resets acknowledged. Internal only: no class or count is ever in a public answer.

export const DOOR_HEADER = "x-nablaz-door";
export const CLASS_HEADER = "x-nablaz-class";
/** Must equal the front's DOORS and CALLER_CLASSES (packages/mcp/src/caller.ts; a test pins it). */
export const DOORS = ["read", "mcp"] as const;
export const CALLER_CLASSES = ["fixture", "ci", "watcher", "cto", "site", "se", "ingester", "unclassified"] as const;
export type DoorStage = "attempt" | "served";

// Process-wide, as the RPC counters (src/rpc.ts), so a second module instance cannot split the count.
const COUNTERS = Symbol.for("nablaz.reader.doorCounters");
const store = (): Map<string, number> => ((globalThis as Record<symbol, Map<string, number>>)[COUNTERS] ??= new Map());

/** Counts one request when both headers carry a known value; otherwise nothing. In memory, no I/O. */
export function countDoor(stage: DoorStage, door: string | undefined | null, cls: string | undefined | null): void {
  if (!door || !cls || !(DOORS as readonly string[]).includes(door) || !(CALLER_CLASSES as readonly string[]).includes(cls)) return;
  const k = `${door}\u0000${cls}\u0000${stage}`;
  store().set(k, (store().get(k) ?? 0) + 1);
}

/** Clears every counter (tests). */
export function resetDoorCounters(): void {
  store().clear();
}

/** The counters in Prometheus text format, door, class and stage labels only. */
export function doorMetricsText(): string {
  const name = "nablaz_door_requests_total";
  const rows = [...store().entries()]
    .map(([k, n]) => {
      const [door, cls, stage] = k.split("\u0000");
      return `${name}{door="${door}",class="${cls}",stage="${stage}"} ${n}`;
    })
    .sort();
  return (
    [
      `# HELP ${name} Read attempts (stage attempt) and reads served (stage served) at the public doors, by caller class; MCP discovery calls and 429s are not counted (front log lines only).`,
      `# TYPE ${name} counter`,
      ...rows,
    ].join("\n") + "\n"
  );
}
