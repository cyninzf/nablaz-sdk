// P-GTM-4, the outside-read instrument (R-S214-11, R-S217-7). The front sorts every request at the two public read
// doors (HTTP GET /read and POST /mcp) into a caller class, at request time and from the request's own headers only:
//   1. x-nablaz-caller, when its value is exactly one of CALLER_VALUES (our own callers); any other value is ignored;
//   2. else the user-agent, against the ingester rules in caller-ua.json (data, not code: registry ingesters and
//      health checkers, each added only from a user-agent observed in the per-request log line, never guessed);
//   3. else "unclassified", the outside-candidate class.
// The class is internal bookkeeping only. It grants nothing, changes no answer, and no class, count or number from
// it is ever written into a response body. It labels callers of the doors, never subjects of the record.
// Spoofing errs one way only: an outsider sending x-nablaz-caller is counted as ours, which undercounts outside reads
// and raises the human gate earlier, never later. The internal loopback headers (DOOR_HEADER, CLASS_HEADER) are set
// by the front on its own fetches to the reader; a caller's copy of them is never forwarded.

import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";

/** The header our own callers send. */
export const CALLER_HEADER = "x-nablaz-caller";
/** The fixed allowlist of x-nablaz-caller values (R-S217-7). */
export const CALLER_VALUES = ["fixture", "ci", "watcher", "cto", "site", "se"] as const;
export type CallerClass = (typeof CALLER_VALUES)[number] | "ingester" | "unclassified";
/** Every class the front can assign; the reader counts only these (packages/reader/src/api/callers.ts). */
export const CALLER_CLASSES: readonly CallerClass[] = [...CALLER_VALUES, "ingester", "unclassified"];

/** The two public read doors. */
export type Door = "read" | "mcp";
export const DOORS: readonly Door[] = ["read", "mcp"];

/** Internal headers on the front's loopback fetches to the reader (its readiness check and the /read relay). */
export const DOOR_HEADER = "x-nablaz-door";
export const CLASS_HEADER = "x-nablaz-class";

/** One ingester rule: a case-insensitive substring of the user-agent, and where and when it was observed. */
export type UaRule = { contains: string; observed: string };

/** caller-ua.json, read once at module load. Ships empty (R-S217-7): entries come from observed log lines only. */
export const UA_RULES: readonly UaRule[] = (JSON.parse(readFileSync(new URL("./caller-ua.json", import.meta.url), "utf8")) as { ingester: UaRule[] }).ingester;

/** How much of the user-agent the log line keeps. */
export const UA_LOGGED_MAX = 160;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The caller class of a request, from its headers alone: in-memory, no I/O. */
export function classify(headers: IncomingHttpHeaders, rules: readonly UaRule[] = UA_RULES): CallerClass {
  const declared = first(headers[CALLER_HEADER]);
  if (declared !== undefined && (CALLER_VALUES as readonly string[]).includes(declared)) return declared as CallerClass;
  const ua = (first(headers["user-agent"]) ?? "").toLowerCase();
  if (ua && rules.some((r) => r.contains !== "" && ua.includes(r.contains.toLowerCase()))) return "ingester";
  return "unclassified";
}

/**
 * The door a request is at, or null (every other path, /feed and /ready included, is not a read door). The path is
 * parsed exactly as the front's router parses it (new URL against a dummy base), so the two never disagree.
 */
export function doorOf(method: string | undefined, rawUrl: string | undefined, readPath: RegExp, mcpPath: string): Door | null {
  let path: string;
  try {
    path = new URL(rawUrl ?? "/", "http://x").pathname;
  } catch {
    return null;
  }
  if (method === "GET" && readPath.test(path)) return "read";
  if (path === mcpPath) return "mcp";
  return null;
}

/**
 * The per-request log line: door, class, the response status ("aborted" when the response never finished), a
 * truncated user-agent and the UTC time. No IP address, no header other than the user-agent, no body.
 */
export function callerLogLine(door: Door, cls: CallerClass, status: number | "aborted", userAgent: string | undefined, at = new Date()): string {
  return `caller ${JSON.stringify({ t: at.toISOString(), door, class: cls, status, ua: (userAgent ?? "").slice(0, UA_LOGGED_MAX) })}`;
}

/** `get` with the internal door and class headers set on every request, overriding any of the same name. */
export function tagged(get: typeof fetch, door: Door, cls: CallerClass): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    headers.set(DOOR_HEADER, door);
    headers.set(CLASS_HEADER, cls);
    return get(input, { ...init, headers });
  }) as typeof fetch;
}
