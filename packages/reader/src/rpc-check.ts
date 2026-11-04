// Row C stub (red commit): the startup RPC check is not implemented yet.
import type { EnabledChain } from "./chains.ts";
export type LegCheck = { chain: string; leg: "indexer" | "grounding"; env: string; host: string; ok: boolean; head?: bigint; detail?: string };
export async function checkRpcLegs(_chains: EnabledChain[], _env: Record<string, string | undefined> = process.env): Promise<LegCheck[]> {
  return [];
}
