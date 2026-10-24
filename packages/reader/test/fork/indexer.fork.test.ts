// Phase 0 replay on an anvil fork, then the indexer from scratch; asserts the derived rows.
// Determinism: a second index from scratch over the same chain gives identical tables.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARBITRUM_ONE } from "@nablaz/sdk/addresses";
import { ENVELOPE_CHANGED, ENVELOPE_LABEL } from "../../src/derive";
import { TABLES, indexOnce, startAnvil, type Anvil, type Tables } from "./harness";
import { FORK_BLOCK, runScenario, type Scenario } from "./scenario";

const lc = (s: string) => s.toLowerCase();
const num = (v: unknown) => BigInt(v as string | number | bigint);

let anvil: Anvil;
let s: Scenario;
let t: Tables;

beforeAll(async () => {
  anvil = await startAnvil(FORK_BLOCK);
  s = await runScenario(anvil.url);
  t = (await indexOnce({ rpcUrl: anvil.url, startBlock: FORK_BLOCK + 1, endBlock: s.endBlock })).tables;
});

afterAll(async () => {
  await anvil?.stop();
});

describe("every row cites its evidence", () => {
  it("block, tx hash, log index and a reproducing command on every row of every table", () => {
    for (const name of TABLES) {
      for (const row of t[name]) {
        expect(num(row.block_number), name).toBeGreaterThan(BigInt(FORK_BLOCK));
        expect(row.tx_hash, name).toMatch(/^0x[0-9a-f]{64}$/);
        expect(typeof row.log_index, name).toBe("number");
        expect(row.reproduce, name).toContain(`--from-block ${row.block_number} --to-block ${row.block_number}`);
        expect(JSON.parse(row.reproduce_get_logs as string).method, name).toBe("eth_getLogs");
      }
    }
  });
});

describe("vault_payments (P0-1, P0-2, R-S184-2, R-B0-1, R-D2B-6)", () => {
  it("one row per settlement, paired to its Transfer", () => {
    expect(t.vault_payments).toHaveLength(s.settlements.length);
    for (const x of s.settlements) {
      const row = t.vault_payments.find((r) => r.tx_hash === x.tx && r.nonce === lc(x.nonce));
      expect(row, x.label).toBeDefined();
      expect(row!.vault, x.label).toBe(lc(x.vault));
      expect(row!.account, x.label).toBe(lc(x.account));
      expect(row!.payee, x.label).toBe(lc(x.payee));
      expect(num(row!.value), x.label).toBe(x.value);
      // P0-1: AuthorizationUsed, then the Transfer, adjacent.
      expect(row!.transfer_log_index, x.label).toBe((row!.log_index as number) + 1);
      expect(row!.reproduce_transfer, x.label).toContain(`--from-block ${x.block} `);
      // tx.from is the submitter and never the counterparty.
      expect(row!.submitter, x.label).toBe(lc(x.submitter));
      expect(row!.submitter, x.label).not.toBe(row!.payee);
      // Grant from logs.
      expect(row!.grant_id_from_logs, x.label).toBe(lc(x.grantId));
      expect(row!.funding_entry_id, x.label).toBeTruthy();
    }
  });

  it("envelope expiry from envelopeOf at N−1 and N, labelled and cited", () => {
    for (const x of s.settlements) {
      const row = t.vault_payments.find((r) => r.tx_hash === x.tx && r.nonce === lc(x.nonce))!;
      expect(row.envelope_label).toBe(ENVELOPE_LABEL);
      expect(row.envelope_mandate).toBe(lc(ARBITRUM_ONE.contracts.ConsumerAIMandateV4.address));
      expect(row.reproduce_envelope_at_prev).toMatch(new RegExp(`^cast call --block ${x.block - 1n} `));
      expect(row.reproduce_envelope_at_block).toMatch(new RegExp(`^cast call --block ${x.block} `));
      if (x.expectExpiry === "not determinable") {
        expect(row.envelope_status, x.label).toBe(ENVELOPE_CHANGED);
        expect(row.envelope_expiry, x.label).toBeNull();
        expect(row.envelope_grant_id, x.label).toBeNull();
        expect(num(row.envelope_at_prev_expiry)).not.toBe(num(row.envelope_at_block_expiry));
      } else {
        expect(row.envelope_status, x.label).toBe("determinate");
        expect(num(row.envelope_expiry), x.label).toBe(x.expectExpiry);
        expect(row.envelope_grant_id, x.label).toBe(lc(x.grantId));
        expect(row.grant_matches_envelope, x.label).toBe(true);
      }
    }
  });

  it("(iv-b): no PAY_AUTHORIZED for E2, yet the expiry read is E2's", () => {
    const c = s.cases.find((k) => k.label === "(iv-b)")!;
    const x = s.settlements.find((k) => k.label.startsWith("(iv-b)"))!;
    const fundings = t.record_entries.filter((r) => r.kind_name === "PAY_AUTHORIZED" && r.subject === lc(c.account));
    expect(fundings).toHaveLength(1);
    const row = t.vault_payments.find((r) => r.tx_hash === x.tx)!;
    expect(row.funding_entry_id).toBe(fundings[0]!.id);
    expect(num(row.envelope_expiry)).toBe(x.expectExpiry);
  });

  it("(iv-a): the E1-signed authorization pairs with E2's funding", () => {
    const c = s.cases.find((k) => k.label === "(iv-a)")!;
    const fundings = t.record_entries
      .filter((r) => r.kind_name === "PAY_AUTHORIZED" && r.subject === lc(c.account))
      .sort((a, b) => Number(num(a.block_number) - num(b.block_number)));
    expect(fundings).toHaveLength(2);
    const x = s.settlements.find((k) => k.label.startsWith("(iv-a)"))!;
    expect(t.vault_payments.find((r) => r.tx_hash === x.tx)!.funding_entry_id).toBe(fundings[1]!.id);
  });

  it("R-D2B-6: settlements counted per log; a batch tx carries two", () => {
    const batch = t.vault_payments.filter((r) => s.settlements.some((x) => x.label.startsWith("(batch)") && x.tx === r.tx_hash));
    expect(batch).toHaveLength(2);
    expect(batch.map((r) => r.settlements_in_tx)).toEqual([2, 2]);
    expect(batch.map((r) => r.settlement_ordinal_in_tx).sort()).toEqual([0, 1]);
    for (const r of t.vault_payments) {
      expect(r.settlements).toBe(1);
      expect(r.calls).toBeNull();
      expect(r.calls_status).toMatch(/^not determinable/);
    }
  });
});

describe("vaults from logs alone (P0-4)", () => {
  it("each case's vault is discovered from PAY_AUTHORIZED + the funding Transfer, and CREATE2 agrees", () => {
    expect(t.vaults).toHaveLength(s.cases.length);
    for (const c of s.cases) {
      const v = t.vaults.find((r) => r.vault === lc(c.vault));
      expect(v, c.label).toBeDefined();
      expect(v!.account).toBe(lc(c.account));
      expect(v!.grantee).toBe(lc(c.agent));
      expect(v!.grantee_key).toBe(lc(c.granteeKey));
      expect(v!.create2_matches).toBe(true);
      expect(v!.funding_transfer_seen).toBe(true);
    }
  });

  it("PAY_AUTHORIZED count per account equals the reservations that topped up", () => {
    for (const c of s.cases) {
      const n = t.record_entries.filter((r) => r.kind_name === "PAY_AUTHORIZED" && r.subject === lc(c.account)).length;
      expect(n, c.label).toBe(c.fundings);
      const f = t.vault_fundings.find((r) => r.vault === lc(c.vault))!;
      expect(f.funding_count, c.label).toBe(c.fundings);
    }
  });
});

describe("record_entries", () => {
  it("raw entries: ACCOUNT_OPENED and GRANT_SET per account, KILL_SWITCH for kill and unkill", () => {
    for (const c of s.cases) {
      const kinds = t.record_entries.filter((r) => r.subject === lc(c.account)).map((r) => r.kind_name);
      expect(kinds.filter((k) => k === "ACCOUNT_OPENED"), c.label).toHaveLength(1);
      expect(kinds.filter((k) => k === "GRANT_SET"), c.label).toHaveLength(1);
      expect(kinds.filter((k) => k === "KILL_SWITCH"), c.label).toHaveLength(c.kills * 2);
    }
    const ks = t.record_entries.filter((r) => r.kind_name === "KILL_SWITCH");
    expect(ks.map((r) => num(r.counterparty_auth)).sort()).toEqual([0n, 1n]);
    for (const r of t.record_entries) {
      expect(r.emitter).toBe(lc(ARBITRUM_ONE.contracts.NablaRecord.address));
      expect(r.reproduce).toContain(r.emitter as string);
    }
  });
});

describe("obligation_pairs", () => {
  it("OPENED / REPAY / CLOSED grouped by obligationRef; a ref-0 REPAY stays unlinked", () => {
    const o = s.obligation;
    const rows = t.obligation_pairs.filter((r) => r.subject === lc(o.subject));
    expect(rows).toHaveLength(4);
    const byTx = (i: number) => rows.find((r) => r.tx_hash === o.txs[i])!;
    const opened = byTx(0);
    expect(opened.role).toBe("OPENED");
    expect(opened.obligation_ref).toBe(lc(o.ref));
    expect(opened.opened_entry_id).toBe(opened.id);
    expect(byTx(1)).toMatchObject({ role: "REPAY", obligation_ref: lc(o.ref), opened_entry_id: opened.id });
    expect(byTx(2)).toMatchObject({ role: "REPAY", opened_entry_id: null });
    expect(byTx(3)).toMatchObject({ role: "CLOSED", obligation_ref: lc(o.ref), opened_entry_id: opened.id });
  });
});

describe("implementation_history", () => {
  it("Upgraded on every account proxy: bootstrap, then the account implementation", () => {
    for (const c of s.cases) {
      const ups = t.implementation_history
        .filter((r) => r.account === lc(c.account) && r.source === "Upgraded")
        .sort((a, b) => Number(num(a.block_number) - num(b.block_number)) || (a.log_index as number) - (b.log_index as number));
      expect(ups.length, c.label).toBeGreaterThanOrEqual(2);
      expect(ups[1]!.implementation, c.label).toBe(lc(ARBITRUM_ONE.contracts.NablaAccountV3.address));
    }
  });

  it("an upgrade writes both IMPLEMENTATION_CHANGED and Upgraded", () => {
    const u = s.upgraded;
    const rows = t.implementation_history.filter((r) => r.tx_hash === u.tx);
    expect(rows.map((r) => r.source).sort()).toEqual(["IMPLEMENTATION_CHANGED", "Upgraded"]);
    for (const r of rows) expect(r.implementation).toBe(lc(u.implementation));
  });

  it("accounts are discovered from both the factory and the registry", () => {
    for (const c of s.cases) {
      const a = t.accounts.find((r) => r.account === lc(c.account))!;
      expect(a, c.label).toBeDefined();
      expect(a.via_factory && a.via_registry, c.label).toBe(true);
      expect(a.owner).toBe(lc(c.owner));
    }
  });
});

describe("counterparties", () => {
  it("distinct counterparties per subject; the submitter never appears", () => {
    for (const c of s.cases) {
      const rows = t.counterparties.filter((r) => r.subject === lc(c.account));
      expect(rows.map((r) => r.counterparty), c.label).toEqual([lc(c.payee)]);
      const settled = s.settlements.filter((x) => x.account === c.account).length;
      expect(rows[0]!.vault_settlement_count, c.label).toBe(settled);
      expect(rows[0]!.record_entry_count, c.label).toBe(0);
    }
    const submitters = new Set(s.settlements.map((x) => lc(x.submitter)));
    for (const r of t.counterparties) expect(submitters.has(r.counterparty as string)).toBe(false);
    const o = t.counterparties.find((r) => r.subject === lc(s.obligation.subject))!;
    expect(o.counterparty).toBe(lc(s.obligation.lender));
    expect(o.record_entry_count).toBe(4);
  });
});

describe("determinism", () => {
  it("indexing from scratch twice gives identical tables", async () => {
    const again = (await indexOnce({ rpcUrl: anvil.url, startBlock: FORK_BLOCK + 1, endBlock: s.endBlock })).tables;
    expect(again).toEqual(t);
  });
});
