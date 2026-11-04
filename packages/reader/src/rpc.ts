// RPC roles per chain (R-S192-8, R-S192-4 AMENDED). Each chain reads two URLs from the environment:
//   rpcEnv (Chainstack): the indexer's head tracking, and the read's state reads at the indexed block.
//   groundingRpcEnv (Alchemy): backfill eth_getLogs and the grounding reads, both over unlimited block ranges.
// The indexer's transport routes by request. A range eth_getLogs (fromBlock/toBlock) is backfill: Ponder's
// realtime sync asks for logs by blockHash only, so a range call never comes from head tracking. It goes to the
// grounding URL alone. Every other call is head tracking and goes to fallback([indexer, grounding]): the
// grounding URL is used only when the indexer URL fails. The Chainstack leg refuses a range eth_getLogs over
// CHAINSTACK_LOGS_RANGE blocks before sending it. Ponder's ethGetLogsBlockRange is per chain, so setting it
// would cap the Alchemy leg too; the cap is held here instead.
// The grounding client is built from groundingRpcEnv only; it never sees the indexer URL.
// Every http transport here is built by boundedHttp (READER_MAX_RESPONSE_BYTES, R-S197-7), and every leg is
// wrapped by redacting, so an RPC error never carries a transport URL or the key in it (R-S197-8), says which leg
// and chain it came from (R-S194-10), and is counted per chain and leg for /metrics/reader (row E).

import { createPublicClient, custom, fallback, http, type EIP1193RequestFn, type PublicClient, type Transport } from "viem";
import type { ChainSources } from "./chains.ts";

/** eth_getLogs block-range limit of the Chainstack plan (Growth). */
export const CHAINSTACK_LOGS_RANGE = 10_000;

/**
 * Response body ceiling of every RPC transport here (R-S197-7): 32 MiB. viem's default (10_485_760) is below a
 * real Base block (block 51,354,171 with full transactions = 10,502,144 bytes). About 3x that block, under 2% of
 * the serving machine's 2 GB. Bounded on purpose: never false (unlimited).
 */
export const READER_MAX_RESPONSE_BYTES = 33_554_432;

/** viem's http transport with the response body ceiling (`maxResponseBodySize`) set to READER_MAX_RESPONSE_BYTES. */
export function boundedHttp(url: string): Transport {
  return http(url, { maxResponseBodySize: READER_MAX_RESPONSE_BYTES });
}

export type RpcLeg = "indexer" | "grounding";

const URL_PATTERN = /(?:https?|wss?):\/\/[^\s"'`<>)\]]+/g;

/** `text` with every occurrence of `url`, and any other http(s)/ws(s) URL, replaced by [redacted:<leg>]. */
export function redactUrls(text: string, url: string, leg: RpcLeg): string {
  const mark = `[redacted:${leg}]`;
  return (url ? text.split(url).join(mark) : text).replace(URL_PATTERN, mark);
}

/** Scrubs the error's text fields in place (and its causes'); the error object, and so its class, is unchanged. */
function scrub(err: unknown, url: string, leg: RpcLeg, depth = 0): void {
  if (depth > 8 || typeof err !== "object" || err === null) return;
  const e = err as Record<string, unknown>;
  for (const k of ["message", "shortMessage", "details", "url", "stack"]) {
    if (typeof e[k] === "string") e[k] = redactUrls(e[k] as string, url, leg);
  }
  if (Array.isArray(e.metaMessages)) e.metaMessages = e.metaMessages.map((m) => (typeof m === "string" ? redactUrls(m, url, leg) : m));
  scrub(e.cause, url, leg, depth + 1);
}

/**
 * Row D (R-S194-10): prefixes the error's message and shortMessage with "[rpc <chain> <leg>] ", once, so a logged
 * RPC error says which leg and chain it came from. Other fields, and the error's class, are unchanged.
 */
function tag(err: unknown, leg: RpcLeg, chain: string): void {
  if (typeof err !== "object" || err === null) return;
  const e = err as Record<string, unknown>;
  retag(e, `[rpc ${chain ? `${chain} ` : ""}${leg}] `);
}

// Row E: per chain and leg counters, process-wide (globalThis: Ponder loads ponder.config.ts and src/api apart, so a
// module-level map could exist twice). Read by rpcMetricsText, served by the reader on loopback at /metrics/reader.
type LegCounters = { requests: number; errors: number; rateLimited: number; lastErrorAt: number; lastRateLimitedAt: number };
const COUNTERS = Symbol.for("nablaz.reader.rpcCounters");
const store = (): Map<string, LegCounters> => ((globalThis as Record<symbol, Map<string, LegCounters>>)[COUNTERS] ??= new Map());
const countersOf = (chain: string, leg: RpcLeg): LegCounters => {
  const k = `${chain}\u0000${leg}`;
  let c = store().get(k);
  if (!c) store().set(k, (c = { requests: 0, errors: 0, rateLimited: 0, lastErrorAt: 0, lastRateLimitedAt: 0 }));
  return c;
};

/** Seconds a 429 keeps a leg's rate_limited_recent at 1. */
export const RATE_LIMITED_RECENT_SECONDS = 60;

/** An HTTP 429, a JSON-RPC 429 or -32005, or a "rate limit" / "too many requests" text, anywhere in the cause chain. */
export function isRateLimited(err: unknown, depth = 0): boolean {
  if (depth > 8 || typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.status === 429 || e.code === 429 || e.code === -32005) return true;
  if (typeof e.message === "string" && /rate limit|too many requests/i.test(e.message)) return true;
  return isRateLimited(e.cause, depth + 1);
}

/** Clears every counter (tests). */
export function resetRpcCounters(): void {
  store().clear();
}

/** The counters in Prometheus text format: chain and leg labels only, never a URL or host. */
export function rpcMetricsText(now = Date.now()): string {
  const rows = [...store().entries()].map(([k, c]) => {
    const [chain, leg] = k.split("\u0000");
    return { labels: `{chain="${chain}",leg="${leg}"}`, c };
  });
  const metric = (name: string, type: string, help: string, value: (c: LegCounters) => number) =>
    [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows.map((r) => `${name}${r.labels} ${value(r.c)}`)].join("\n");
  return (
    [
      metric("nablaz_rpc_requests_total", "counter", "RPC requests sent per chain and leg (after viem's retries, one per call).", (c) => c.requests),
      metric("nablaz_rpc_errors_total", "counter", "RPC requests that failed, per chain and leg.", (c) => c.errors),
      metric("nablaz_rpc_rate_limited_total", "counter", "Failures that were rate limits (HTTP 429, JSON-RPC 429 or -32005).", (c) => c.rateLimited),
      metric("nablaz_rpc_rate_limited_recent", "gauge", `1 when the leg was rate limited in the last ${RATE_LIMITED_RECENT_SECONDS} s.`, (c) =>
        c.lastRateLimitedAt && now - c.lastRateLimitedAt <= RATE_LIMITED_RECENT_SECONDS * 1000 ? 1 : 0,
      ),
      metric("nablaz_rpc_last_error_timestamp_seconds", "gauge", "Unix time of the leg's last failure, 0 if none.", (c) => Math.floor(c.lastErrorAt / 1000)),
      metric("nablaz_rpc_last_rate_limited_timestamp_seconds", "gauge", "Unix time of the leg's last rate limit, 0 if none.", (c) => Math.floor(c.lastRateLimitedAt / 1000)),
    ].join("\n") + "\n"
  );
}

/**
 * `inner`, rethrowing every request error (the same error object) with its transport URLs redacted and its message
 * tagged with the leg and chain; every request and failure is counted for /metrics/reader.
 */
export function redacting(inner: Transport, url: string, leg: RpcLeg, chain = ""): Transport {
  return (config) => {
    const t = inner(config);
    const request: EIP1193RequestFn = async (args) => {
      const c = countersOf(chain, leg);
      c.requests++;
      try {
        return await t.request(args as never);
      } catch (err) {
        c.errors++;
        c.lastErrorAt = Date.now();
        if (isRateLimited(err)) {
          c.rateLimited++;
          c.lastRateLimitedAt = c.lastErrorAt;
        }
        scrub(err, url, leg);
        tag(err, leg, chain);
        throw err;
      }
    };
    return { ...t, request };
  };
}

export type RpcUrls = { indexer: string; grounding: string };

/** Both URLs of a chain, from the environment; throws naming the variable that is unset. */
export function rpcUrls(c: Pick<ChainSources, "rpcEnv" | "groundingRpcEnv">, env = process.env): RpcUrls {
  const indexer = env[c.rpcEnv];
  const grounding = env[c.groundingRpcEnv];
  if (!indexer) throw new Error(`${c.rpcEnv} is not set`);
  if (!grounding) throw new Error(`${c.groundingRpcEnv} is not set`);
  return { indexer, grounding };
}

type Filter = { fromBlock?: string; toBlock?: string; blockHash?: string };

/** A range eth_getLogs: one with no blockHash. Ponder's realtime sync never sends one. */
export function isRangeGetLogs(method: string, params: unknown): boolean {
  if (method !== "eth_getLogs") return false;
  const f = (Array.isArray(params) ? params[0] : undefined) as Filter | undefined;
  return f?.blockHash === undefined;
}

/** Blocks a range filter spans; undefined when either end is a tag (latest, finalized, ...). */
function span(f: Filter): bigint | undefined {
  const n = (x?: string) => (x !== undefined && /^0x[0-9a-f]+$/i.test(x) ? BigInt(x) : undefined);
  const from = n(f.fromBlock);
  const to = n(f.toBlock);
  return from === undefined || to === undefined ? undefined : to - from + 1n;
}

/** `inner`, refusing a range eth_getLogs over `maxRange` blocks (or with a tag end) before it is sent. */
export function cappedLogs(inner: Transport, maxRange: number): Transport {
  return (config) => {
    const t = inner(config);
    const request: EIP1193RequestFn = async (args) => {
      if (isRangeGetLogs(args.method, args.params)) {
        const s = span((args.params as Filter[])[0]!);
        if (s === undefined || s > BigInt(maxRange)) throw new Error(`eth_getLogs over more than ${maxRange} blocks, or to a block tag, is not sent to this transport`);
      }
      return t.request(args as never);
    };
    return { ...t, request };
  };
}

export type IndexerTransports = { indexer?: Transport; grounding?: Transport };

/**
 * The indexer's transport for one chain: range eth_getLogs to the grounding URL, everything else to
 * fallback([indexer capped at CHAINSTACK_LOGS_RANGE, grounding]). `legs` replaces the two http transports (tests);
 * the URL redaction wraps injected legs too.
 */
export function indexerTransport(urls: RpcUrls, legs: IndexerTransports = {}, chain = ""): Transport {
  const indexer = redacting(cappedLogs(legs.indexer ?? boundedHttp(urls.indexer), CHAINSTACK_LOGS_RANGE), urls.indexer, "indexer", chain);
  const grounding = redacting(legs.grounding ?? boundedHttp(urls.grounding), urls.grounding, "grounding", chain);
  const head = fallback([indexer, grounding]);
  return (config) => {
    const h = head(config);
    const g = grounding(config);
    const t = custom({
      request: ({ method, params }) => (isRangeGetLogs(method, params) ? g.request({ method, params } as never) : h.request({ method, params } as never)),
    })(config);
    // viem's custom transport rebuilds the error it surfaces (the leg's error becomes its cause); carry the leg's
    // tag up to it, so the error Ponder logs says which leg failed.
    const request: EIP1193RequestFn = async (args) => {
      try {
        return await t.request(args as never);
      } catch (err) {
        const mark = legMark(err);
        if (mark) retag(err, mark);
        throw err;
      }
    };
    return { ...t, request };
  };
}

/** The first "[rpc ...] " tag in the error's cause chain. */
function legMark(err: unknown, depth = 0): string | undefined {
  if (depth > 8 || typeof err !== "object" || err === null) return undefined;
  const m = String((err as { message?: unknown }).message ?? "").match(/^\[rpc [^\]]+\] /);
  return m ? m[0] : legMark((err as { cause?: unknown }).cause, depth + 1);
}

function retag(err: unknown, mark: string): void {
  const e = err as Record<string, unknown>;
  for (const k of ["message", "shortMessage"]) {
    if (typeof e[k] === "string" && !(e[k] as string).startsWith("[rpc ")) e[k] = mark + (e[k] as string);
  }
}

/** The grounding reads' client for one chain, from groundingRpcEnv only (R-S192-8). */
export function groundingClient(c: Pick<ChainSources, "groundingRpcEnv"> & Partial<Pick<ChainSources, "name">>, env = process.env): PublicClient {
  const url = env[c.groundingRpcEnv];
  if (!url) throw new Error(`${c.groundingRpcEnv} is not set`);
  return createPublicClient({ transport: redacting(boundedHttp(url), url, "grounding", c.name ?? "") }) as PublicClient;
}

