// GET /read assembly (src/read.ts): controller (R-S189-4 AMENDED 2), self-dealing facts, exposure, notes
// (R-S189-6), and R-S189-5: the API never labels a payer "an agent".

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { LABEL } from "../../src/labels";
import {
  OUTSTANDING_AUTHORIZATIONS,
  SELF_DEALING_SENTENCE,
  controllerAt,
  emptySourceNotes,
  exposure,
  notDeterminableNotes,
  paymentFacts,
  recordFacts,
  redemptionFacts,
  selfDealing,
  vaultPaymentFacts,
  type ControllerInput,
} from "../../src/read";

const ACC: Address = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
const OTHER: Address = "0x1111111111111111111111111111111111111111";
const OWNER: Address = "0x2222222222222222222222222222222222222222";
const NEW_CTRL: Address = "0x3333333333333333333333333333333333333333";
const CLAIMED: Address = "0x4444444444444444444444444444444444444444";
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const ev = (block: number, logIndex = 0) => ({ chainId: 42161, blockNumber: BigInt(block), txHash: `0x${"aa".repeat(32)}`, logIndex });
const rotation = (block: number, writer: Address, counterparty: Address) => ({ ...ev(block), subject: ACC, writer, counterparty, kindName: "CONTROLLER_ROTATED" });

describe("controllerAt (R-S189-4 AMENDED 2)", () => {
  const base: ControllerInput = { rotations: [], factoryOwner: OWNER, canonicalImpl: true };
  it("falls back to the factory's own AccountCreated owner", () => {
    expect(controllerAt(ACC, 100n, base)).toMatchObject({ controller: OWNER, from: "AccountCreated" });
  });
  it("takes the latest self-written CONTROLLER_ROTATED at or before the block", () => {
    const x = { ...base, rotations: [rotation(10, ACC, NEW_CTRL)] };
    expect(controllerAt(ACC, 9n, x).controller).toBe(OWNER);
    expect(controllerAt(ACC, 10n, x)).toMatchObject({ controller: NEW_CTRL, from: "CONTROLLER_ROTATED" });
  });
  it("ignores a rotation another writer placed through writeWithConsent", () => {
    const x = { ...base, rotations: [rotation(10, ACC, NEW_CTRL), rotation(20, OTHER, CLAIMED)] };
    expect(controllerAt(ACC, 30n, x).controller).toBe(NEW_CTRL);
    expect(controllerAt(ACC, 30n, { ...base, rotations: [rotation(20, OTHER, CLAIMED)] }).controller).toBe(OWNER);
  });
  it("non-canonical implementation → not determinable", () => {
    expect(controllerAt(ACC, 30n, { ...base, canonicalImpl: false })).toMatchObject({ controller: null });
  });
});

describe("selfDealing", () => {
  const pay = (payee: Address, value: bigint, block = 50) => ({ payee, token: USDC, value, block: BigInt(block), cite: { chainId: 42161, block: String(block), tx: `0x${"bb".repeat(32)}` as const, logIndex: 1 } });
  it("four facts and the fixed sentence, verbatim", () => {
    const r = selfDealing({
      subject: ACC,
      subjectController: { rotations: [], factoryOwner: OWNER, canonicalImpl: true },
      payments: [pay(OTHER, 30n), pay(NEW_CTRL, 70n), pay(OTHER, 0n)],
      // NEW_CTRL is a NablaZ account under the same owner; OTHER is not a NablaZ account and has no record.
      payeeControllers: new Map([[NEW_CTRL.toLowerCase(), { rotations: [], factoryOwner: OWNER, canonicalImpl: true }]]),
      payeesWithRecord: new Set([NEW_CTRL.toLowerCase()]),
    });
    expect(r.result.sentence).toBe("A payee controlled by the same person under another key cannot be detected from chain data.");
    expect(r.result.sentence).toBe(SELF_DEALING_SENTENCE);
    expect(r.result.distinctCounterparties).toBe(2);
    expect(r.result.settlements).toBe(3); // batch-aware: one per authorization, R-D2B-6
    expect((r.result.shareToSameController as any)[USDC.toLowerCase()]).toMatchObject({ value: "70", total: "100", share: 0.7 });
    expect((r.result.shareToCounterpartiesWithoutRecord as any)[USDC.toLowerCase()]).toMatchObject({ value: "30", share: 0.3 });
  });
  it("non-canonical: controller not determinable and shares omitted, with a note", () => {
    const r = selfDealing({
      subject: ACC,
      subjectController: { rotations: [], factoryOwner: OWNER, canonicalImpl: false },
      payments: [pay(OTHER, 1n)],
      payeeControllers: new Map(),
      payeesWithRecord: new Set(),
    });
    expect(r.result).toMatchObject({ controller: "not determinable", shareToSameController: null, shareToCounterpartiesWithoutRecord: null });
    expect(r.notes.join(" ")).toMatch(/not determinable/);
  });
});

describe("exposure (s3 §6.4a reader note)", () => {
  it("min remaining over windows plus vault balance, with the outstanding-authorization limit disclosed", () => {
    const r = exposure(true, [{ grantId: `0x${"01".repeat(32)}`, token: USDC, remaining: [50n, 20n], vault: OTHER, vaultBalance: 7n }], 10n);
    expect((r.result as any).grants[0]).toMatchObject({ minRemainingOverWindows: "20", vaultBalance: "7", exposure: "27" });
    expect(r.result.outstandingAuthorizations).toBe(OUTSTANDING_AUTHORIZATIONS);
  });
  it("not computable off CAM V4", () => {
    const r = exposure(false, [], 10n);
    expect(r.result.computable).toBe(false);
    expect(r.notes[0]).toMatch(/not determinable/);
  });
});

describe("notes (R-S189-6)", () => {
  const ranges = { record: "a", vault_payment: "b", spm: "c", dm: "d", credit: "e" };
  it("states every empty source, and the absent lender, never omitting one", () => {
    const n = emptySourceNotes({ chainId: 8453, hasNabla: false, indexed: new Set(["nabla", "external"]), lenders: 0, counts: {}, ranges });
    expect(n).toEqual([
      "no NablaZ source on chain 8453 (R-S189-1)",
      "SpendPermissionManager permissions and spends for this address: empty (c)",
      "DelegationManager redemptions naming this address: empty (d)",
      "no Agent Credit Lines lender registered on this chain",
    ]);
  });
  it("a source group this instance does not index is said so, never reported as empty", () => {
    const n = emptySourceNotes({ chainId: 42161, hasNabla: true, indexed: new Set(["nabla"]), lenders: 0, counts: { record: 1, vault_payment: 1 }, ranges });
    expect(n.join("\n")).toMatch(/third-party sources: not indexed by this instance/);
    expect(n.join("\n")).not.toMatch(/: empty/);
  });
  it("every (c) fact becomes a note with its citation", () => {
    const f = redemptionFacts([
      { ...ev(5, 2), reproduce: "x", rootDelegator: OTHER, redeemer: OTHER, delegate: OTHER, delegator: OTHER, authority: "0x", hop: "root", delegationHash: "0x", hadTransfer: false, shape: "c", label: LABEL.c, enforcers: [{ enforcer: "0x29fcBBa852439616c4D614A2fa6411E42b760153", name: null }] },
    ]);
    expect(notDeterminableNotes(f)[0]).toMatch(/block 5 .* log 2: \(c\) not determinable \(enforcer not in the table: 0x29fc/);
    expect((f[0]!.terms as any).payment).toMatch(/none: no ERC-20 Transfer/);
  });
});

describe("facts", () => {
  it("own record entries carry the NablaZ label; another writer's are (e) with the writer named", () => {
    const nabla = { shape: "a" as const, label: LABEL.withinMandate, canonicalImpl: true };
    const f = recordFacts([{ ...ev(1), subject: ACC, writer: ACC, kindName: "PAY" }, { ...ev(2), subject: ACC, writer: OTHER, kindName: "EXTERNAL_ATTESTATION" }], nabla);
    expect(f[0]!.label).toBe("(a) within mandate by construction");
    expect(f[1]!.label).toBe(`(e) third-party attestation, writer named: ${OTHER}`);
    expect(f[0]!.reproduce).toContain(ACC);
    expect(f[0]!.cite).toEqual({ chainId: 42161, block: "1", tx: `0x${"aa".repeat(32)}`, logIndex: 0 });
  });
  it("a vault payment cites both one-liners of the pair", () => {
    const f = vaultPaymentFacts([{ ...ev(3), vault: OTHER, token: USDC, settlements: 1, settlementOrdinalInTx: 0, settlementsInTx: 1, calls: null, callsStatus: "not determinable: x" }], null);
    expect(f[0]!.reproduce.split("\n")).toHaveLength(2);
    expect(f[0]!.label).toBe(LABEL.c);
  });
  it("a payment takes its permission's label; a missing permission is (c) and says why", () => {
    const perms = new Map([["8453-dm-0xab", { label: LABEL.bOnce, shape: "b" }]]);
    const f = paymentFacts(
      [
        { ...ev(4), chainId: 8453, source: "delegation_manager", permissionId: "0xAB", reproduce: "r" },
        { ...ev(5), chainId: 8453, source: "delegation_manager", permissionId: "0xcd", reproduce: "r" },
      ],
      perms as any,
    );
    expect(f[0]!.label).toBe(LABEL.bOnce);
    expect(f[1]!.label).toBe(LABEL.c);
  });
});

describe("R-S189-5: no payer is labelled an agent", () => {
  it("the API modules never use the word outside the Agent Credit Lines name and the agentId field", () => {
    for (const p of ["../../src/read.ts", "../../src/api/index.ts", "../../src/labels.ts", "../../src/external.ts"]) {
      const src = readFileSync(new URL(p, import.meta.url), "utf8")
        .replaceAll("Agent Credit Lines", "")
        .replaceAll("AgentCreditLine", "")
        .replaceAll("agentId", "")
        .replaceAll("AGENT_ID", "");
      expect(src, p).not.toMatch(/agents?\b/i);
    }
  });
});
