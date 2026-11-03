// R-S198-2/3: every filter the /read handler issues on its always-run path (src/api/index.ts) has an index in
// ponder.schema.ts whose leading columns are exactly the filter's equality columns. An OR is one arm per index:
// Postgres combines arms with BitmapOr only when every arm has its own index, and one arm without one turns the
// query into a scan of the chain's rows (S198: external_redemptions, 59 s on Arbitrum, past the 30 s limit).
import { describe, expect, it } from "vitest";
import * as s from "../../ponder.schema";

type Col = { name: string; primary?: boolean };
type Table = Record<string | symbol, unknown>;

const COLUMNS = Symbol.for("drizzle:Columns");
const EXTRA_BUILDER = Symbol.for("drizzle:ExtraConfigBuilder");
const EXTRA_COLUMNS = Symbol.for("drizzle:ExtraConfigColumns");

/** Column-name lists of every index on `table`: the primary key and each declared index, in index order. */
function indexesOf(table: Table): string[][] {
  const cols = Object.values(table[COLUMNS] as Record<string, Col>);
  const pk = cols.filter((c) => c.primary).map((c) => [c.name]);
  const build = table[EXTRA_BUILDER] as ((c: unknown) => Record<string, { config: { columns: Col[] } }>) | undefined;
  const declared = build ? Object.values(build(table[EXTRA_COLUMNS])).map((i) => i.config.columns.map((c) => c.name)) : [];
  return [...pk, ...declared];
}

/** Some index's first `arm.length` columns are exactly the arm's columns. */
const covered = (table: Table, arm: Col[]) => {
  const want = new Set(arm.map((c) => c.name));
  return indexesOf(table).some((ix) => ix.length >= want.size && ix.slice(0, want.size).every((n) => want.has(n)));
};

// The always-run queries of GET /read/:chainId/:address, one entry per OR arm.
const FILTERS: [string, Table, Col[][]][] = [
  ["record_entries", s.recordEntries as never, [[s.recordEntries.chainId, s.recordEntries.subject]]],
  ["vault_payments", s.vaultPayments as never, [[s.vaultPayments.chainId, s.vaultPayments.account]]],
  ["external_permissions", s.externalPermissions as never, [
    [s.externalPermissions.chainId, s.externalPermissions.subject],
    [s.externalPermissions.chainId, s.externalPermissions.grantee],
  ]],
  ["external_payments", s.externalPayments as never, [
    [s.externalPayments.chainId, s.externalPayments.payer],
    [s.externalPayments.chainId, s.externalPayments.payee],
  ]],
  ["external_redemptions", s.externalRedemptions as never, [
    [s.externalRedemptions.chainId, s.externalRedemptions.rootDelegator],
    [s.externalRedemptions.chainId, s.externalRedemptions.delegator],
    [s.externalRedemptions.chainId, s.externalRedemptions.delegate],
  ]],
  ["credit_line_events", s.creditLineEvents as never, [[s.creditLineEvents.chainId, s.creditLineEvents.party]]],
  ["accounts", s.accounts as never, [[s.accounts.id]]],
  ["agent_wallets", s.agentWallets as never, [[s.agentWallets.chainId, s.agentWallets.wallet]]],
  ["agent_owners", s.agentOwners as never, [[s.agentOwners.chainId, s.agentOwners.owner]]],
];

describe("/read always-run filters are index-covered", () => {
  for (const [name, table, arms] of FILTERS)
    for (const arm of arms)
      it(`${name} (${arm.map((c) => c.name).join(", ")})`, () => {
        expect(covered(table, arm), `no index on ${name} leads with ${arm.map((c) => c.name).join(", ")}`).toBe(true);
      });

  it("reads the declared indexes (guards the introspection itself)", () => {
    expect(indexesOf(s.recordEntries as never)).toContainEqual(["chain_id", "subject", "seq"]);
    expect(indexesOf(s.accounts as never)).toEqual([["id"]]);
  });
});
