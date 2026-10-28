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

import { createPublicClient, custom, fallback, http, type EIP1193RequestFn, type PublicClient, type Transport } from "viem";
import type { ChainSources } from "./chains.ts";

/** eth_getLogs block-range limit of the Chainstack plan (Growth). */
export const CHAINSTACK_LOGS_RANGE = 10_000;

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
 * fallback([indexer capped at CHAINSTACK_LOGS_RANGE, grounding]). `legs` replaces the two http transports (tests).
 */
export function indexerTransport(urls: RpcUrls, legs: IndexerTransports = {}): Transport {
  const indexer = cappedLogs(legs.indexer ?? http(urls.indexer), CHAINSTACK_LOGS_RANGE);
  const grounding = legs.grounding ?? http(urls.grounding);
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
  return createPublicClient({ transport: http(url) }) as PublicClient;
}
