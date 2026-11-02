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
// wrapped by redacting, so an RPC error never carries a transport URL or the key in it (R-S197-8).

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

/** `inner`, rethrowing every request error (the same error object) with its transport URLs redacted. */
export function redacting(inner: Transport, url: string, leg: RpcLeg): Transport {
  return (config) => {
    const t = inner(config);
    const request: EIP1193RequestFn = async (args) => {
      try {
        return await t.request(args as never);
      } catch (err) {
        scrub(err, url, leg);
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
export function indexerTransport(urls: RpcUrls, legs: IndexerTransports = {}): Transport {
  const indexer = redacting(cappedLogs(legs.indexer ?? boundedHttp(urls.indexer), CHAINSTACK_LOGS_RANGE), urls.indexer, "indexer");
  const grounding = redacting(legs.grounding ?? boundedHttp(urls.grounding), urls.grounding, "grounding");
  const head = fallback([indexer, grounding]);
  return (config) => {
    const h = head(config);
    const g = grounding(config);
    return custom({
      request: ({ method, params }) => (isRangeGetLogs(method, params) ? g.request({ method, params } as never) : h.request({ method, params } as never)),
    })(config);
  };
}

/** The grounding reads' client for one chain, from groundingRpcEnv only (R-S192-8). */
export function groundingClient(c: Pick<ChainSources, "groundingRpcEnv">, env = process.env): PublicClient {
  const url = env[c.groundingRpcEnv];
  if (!url) throw new Error(`${c.groundingRpcEnv} is not set`);
  return createPublicClient({ transport: redacting(boundedHttp(url), url, "grounding") }) as PublicClient;
}
