// The TEST account's baseline (S211): its five facts pinned by (source, block, logIndex) and tx, plus the two live
// check 2 txs (the PAY_AUTHORIZED reservation and its settlement). A post-incident check is mechanical:
//   curl -s https://read.nablaz.io/read/42161/0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c > /tmp/test-read.json
//   cd packages/reader && BASELINE_READ=/tmp/test-read.json npx vitest run --project unit test/unit/test-account-baseline.test.ts
// Without BASELINE_READ only the fixture's own invariants run. Test-only: nothing here is in Ponder's build id.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import baseline from "../fixtures/test-account-baseline.json";

type Row = { source: string; kindName: string | null; block: string; tx: string; logIndex: number };
type ReadFact = { source: string; terms: { kindName?: string }; cite: { chainId: number; block: string; tx: string; logIndex: number } };

/** The rows a GET /read response carries, in the fixture's shape and its order. */
export const rowsOf = (read: { facts: ReadFact[] }): Row[] =>
  read.facts.map((f) => ({ source: f.source, kindName: f.terms.kindName ?? null, block: String(f.cite.block), tx: f.cite.tx.toLowerCase(), logIndex: f.cite.logIndex }));

describe("TEST account baseline fixture", () => {
  const facts = baseline.facts as Row[];

  it("five facts, (block, logIndex) ascending as /read orders them, one per (source, block, logIndex)", () => {
    expect(facts).toHaveLength(5);
    const key = (r: Row) => [BigInt(r.block), r.logIndex] as const;
    for (let i = 1; i < facts.length; i++) {
      const [b0, l0] = key(facts[i - 1]!);
      const [b1, l1] = key(facts[i]!);
      expect(b0 < b1 || (b0 === b1 && l0 < l1)).toBe(true);
    }
    expect(new Set(facts.map((r) => `${r.source}|${r.block}|${r.logIndex}`)).size).toBe(5);
    expect(facts.map((r) => [r.kindName ?? r.source, r.block])).toEqual([
      ["ACCOUNT_OPENED", "517860375"],
      ["GRANT_SET", "518233095"],
      ["PAY_AUTHORIZED", "518233895"],
      ["nablaz:vault_payment", "518234369"],
      ["VAULT_SWEPT", "521815869"],
    ]);
  });

  it("live check 2: the reservation is the PAY_AUTHORIZED fact, the settlement is the vault_payment fact", () => {
    expect(facts.find((r) => r.kindName === "PAY_AUTHORIZED")!.tx).toBe(baseline.liveCheck2.payAuthorizedTx);
    expect(facts.find((r) => r.source === "nablaz:vault_payment")!.tx).toBe(baseline.liveCheck2.settlementTx);
    for (const r of facts) expect(r.tx).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.skipIf(!process.env.BASELINE_READ)("a captured GET /read of the TEST account matches the baseline exactly", () => {
    const read = JSON.parse(readFileSync(process.env.BASELINE_READ!, "utf8"));
    expect(read.chainId).toBe(baseline.chainId);
    expect(read.subject.toLowerCase()).toBe(baseline.subject.toLowerCase());
    expect(rowsOf(read)).toEqual(facts);
  });
});
