// Row C: the startup RPC check. Before Ponder starts (scripts/reader-start.sh runs scripts/check-rpc.ts), each of
// the four legs, the indexer and grounding URL of every enabled chain, must answer eth_chainId with its chain's id
// and eth_blockNumber. A failure names the leg's variable, chain, role and host; the URL's path (where a key
// lives) and the key are never printed. Plain fetch, one attempt per call, no retries: a leg that needs a retry at
// boot is reported, not hidden.

import type { EnabledChain } from "./chains.ts";
import { redactUrls, type RpcLeg } from "./rpc.ts";

export type LegCheck = { chain: string; leg: RpcLeg; env: string; host: string; ok: boolean; head?: bigint; detail?: string };

/** Per-call timeout of the startup check. */
export const RPC_CHECK_TIMEOUT_MS = 10_000;

type Post = (url: string, body: string, signal: AbortSignal) => Promise<Response>;
const defaultPost: Post = (url, body, signal) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal });

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "(not a URL)";
  }
};

/** One JSON-RPC call's result, or a thrown Error whose message carries no URL. */
async function call(url: string, method: string, post: Post, timeoutMs: number, leg: RpcLeg): Promise<string> {
  let r: Response;
  try {
    r = await post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), AbortSignal.timeout(timeoutMs));
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; errors?: { code?: string }[] } };
    const code = err.cause?.code ?? err.cause?.errors?.find((x) => x.code)?.code;
    throw new Error(`${method}: ${err.name}${code ? ` ${code}` : ""}`);
  }
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = (await r.json().catch(() => ({}))) as { result?: unknown; error?: { code?: number; message?: string } };
  if (j.error) throw new Error(`${method}: JSON-RPC ${j.error.code ?? "error"} ${redactUrls(String(j.error.message ?? ""), url, leg).slice(0, 120)}`);
  if (typeof j.result !== "string") throw new Error(`${method}: no result`);
  return j.result;
}

/** Checks every leg of every chain, in chain order, indexer before grounding; never throws. */
export async function checkRpcLegs(chains: EnabledChain[], env: Record<string, string | undefined> = process.env, post: Post = defaultPost, timeoutMs = RPC_CHECK_TIMEOUT_MS): Promise<LegCheck[]> {
  const out: LegCheck[] = [];
  for (const c of chains) {
    for (const [leg, name] of [["indexer", c.rpcEnv], ["grounding", c.groundingRpcEnv]] as const) {
      const url = env[name];
      const base = { chain: c.name, leg, env: name };
      if (!url) {
        out.push({ ...base, host: "", ok: false, detail: "is not set" });
        continue;
      }
      const host = hostOf(url);
      try {
        const id = Number(BigInt(await call(url, "eth_chainId", post, timeoutMs, leg)));
        if (id !== c.chainId) {
          out.push({ ...base, host, ok: false, detail: `eth_chainId is ${id}, expected ${c.chainId}` });
          continue;
        }
        const head = BigInt(await call(url, "eth_blockNumber", post, timeoutMs, leg));
        out.push({ ...base, host, ok: true, head });
      } catch (e) {
        out.push({ ...base, host, ok: false, detail: (e as Error).message });
      }
    }
  }
  return out;
}

/** One line per leg, for the start log. */
export function formatLegCheck(r: LegCheck): string {
  const where = `${r.env} (${r.chain} ${r.leg}${r.host ? `, host ${r.host}` : ""})`;
  return r.ok ? `rpc check ok: ${where} head ${r.head}` : `rpc check FAILED: ${where}: ${r.detail}`;
}
