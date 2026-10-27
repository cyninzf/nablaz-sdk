// R-S190-3: the share of payment facts labelled (c) "not determinable", per chain and per token, over a block
// range of the whole index. Computed from the indexed rows, never estimated. A payment fact is a vault
// settlement (labelled by its account's NablaZ label) or an external payment (labelled by its permission, (c)
// when the permission row is not indexed), as GET /read labels them. Used by scripts/c-share.ts and the fork
// test.

import { getAddress, type Address } from "viem";

/** External payments with their permission's shape: the same join GET /read makes (src/read.ts paymentFacts). */
export const EXTERNAL_PAYMENTS_SQL = `SELECT p.token, p.amount::text AS amount, perm.shape
FROM reader.external_payments p
LEFT JOIN reader.external_permissions perm
  ON perm.id = p.chain_id || '-' || (CASE WHEN p.source = 'spm' THEN 'spm' ELSE 'dm' END) || '-' || lower(p.permission_id)
WHERE p.chain_id = $1 AND p.block_number BETWEEN $2 AND $3`;

/** Settled vault payments; the shape is the paying account's NablaZ label, resolved per account. */
export const VAULT_PAYMENTS_SQL = `SELECT v.account, v.token, v.value::text AS value
FROM reader.vault_payments v
WHERE v.chain_id = $1 AND v.block_number BETWEEN $2 AND $3 AND v.payee IS NOT NULL AND v.value IS NOT NULL`;

export type Query = <T>(sql: string, params: unknown[]) => Promise<T[]>;

export type TokenShare = { c: number; total: number; cValue: bigint; totalValue: bigint };

/** Per token: (c) count and value over all payment facts in [from, to] on the chain. */
export async function cShareOverIndex(
  q: Query,
  chainId: number,
  from: bigint,
  to: bigint,
  /** The NablaZ shape of an account (src/labels.ts nablaLabel); only called when vault payments exist. */
  accountShape: (account: Address) => Promise<string>,
): Promise<Record<string, TokenShare>> {
  const out: Record<string, TokenShare> = {};
  const add = (token: string, shape: string | null, value: bigint) => {
    const t = (out[getAddress(token)] ??= { c: 0, total: 0, cValue: 0n, totalValue: 0n });
    t.total++;
    t.totalValue += value;
    if (shape === null || shape === "c") {
      t.c++;
      t.cValue += value;
    }
  };
  const params = [chainId, from.toString(), to.toString()];
  for (const r of await q<{ token: string; amount: string; shape: string | null }>(EXTERNAL_PAYMENTS_SQL, params)) add(r.token, r.shape, BigInt(r.amount));
  const shapes = new Map<string, string>();
  for (const r of await q<{ account: string; token: string; value: string }>(VAULT_PAYMENTS_SQL, params)) {
    const a = r.account.toLowerCase();
    if (!shapes.has(a)) shapes.set(a, await accountShape(getAddress(a)));
    add(r.token, shapes.get(a)!, BigInt(r.value));
  }
  return out;
}

const pct = (n: bigint, d: bigint) => (d === 0n ? "n/a" : `${(Number((n * 1_000_000n) / d) / 10_000).toFixed(4)}%`);

/** One line per token, with the counts, values and shares. */
export function formatShare(chainId: number, from: bigint, to: bigint, r: Record<string, TokenShare>): string[] {
  const lines = Object.entries(r).map(
    ([token, t]) =>
      `chain ${chainId} blocks ${from}..${to} token ${token}: (c) ${t.c} of ${t.total} payment facts (${pct(BigInt(t.c), BigInt(t.total))}); (c) value ${t.cValue} of ${t.totalValue} (${pct(t.cValue, t.totalValue)})`,
  );
  return lines.length ? lines : [`chain ${chainId} blocks ${from}..${to}: nothing indexed (no payment fact in the range)`];
}
