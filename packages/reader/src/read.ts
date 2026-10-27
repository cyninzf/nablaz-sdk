// GET /read assembly: pure functions from indexed rows and state reads to the response. No I/O; the
// queries and state reads are in src/api/index.ts. Rulings: R-D2B-1 (cite + reproduce on every fact),
// R-D2B-4 (authorization chain per payment), R-D2B-6 (batch-aware counts), R-S189-3 AMENDED 2/3 (labels),
// R-S189-4 AMENDED 2 (controller, self-dealing), R-S189-5 (a redemption is not a payment), R-S189-6
// (empty is reported as empty), s3 §6.4a reader note (exposure).

import { getAddress, type Address, type Hex } from "viem";
import { LABEL, attestationLabel, type NablaLabel } from "./labels.ts";
import { render } from "./oneliners.ts";

/** R-S189-4: the fixed sentence, verbatim (s3 §6.4a). */
export const SELF_DEALING_SENTENCE = "A payee controlled by the same person under another key cannot be detected from chain data.";

/** s3 §6.4a reader note, outstanding authorizations (R-B0-1): a disclosed limit, not a number. */
export const OUTSTANDING_AUTHORIZATIONS =
  "Outstanding authorizations can exist. Each one is bounded by the vault balance and expires at its own validBefore. Unsettled authorizations are not observable onchain.";

export const NOT_DETERMINABLE = "not determinable";

type Row = Record<string, any>;

export type Fact = {
  source: string;
  label: string;
  shape: string;
  terms: Record<string, unknown>;
  cite: { chainId: number; block: string; tx: Hex; logIndex: number };
  reproduce: string;
};

const cite = (r: Row) => ({ chainId: r.chainId as number, block: String(r.blockNumber), tx: r.txHash as Hex, logIndex: r.logIndex as number });
const lc = (a: string) => a.toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lc(a) === lc(b);
const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const plain = (r: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, str(r[k])]));

// ── Controller (R-S189-4 AMENDED 2) ─────────────────────────────────

export type ControllerInput = {
  /** CONTROLLER_ROTATED record entries about the account (any writer). */
  rotations: Row[];
  /** The permanent factory's own AccountCreated owner, or null if the account was not created there. */
  factoryOwner: Address | null;
  /** The account's implementation is in the currentAccountImpl lineage. */
  canonicalImpl: boolean;
};

export type Controller = { controller: Address; from: "CONTROLLER_ROTATED" | "AccountCreated"; cite?: ReturnType<typeof cite> } | { controller: null; reason: string };

/** controller(account) at `block`: the latest self-written CONTROLLER_ROTATED, else the factory's owner. */
export function controllerAt(account: Address, block: bigint, x: ControllerInput): Controller {
  if (!x.canonicalImpl) return { controller: null, reason: `${NOT_DETERMINABLE}: implementation is not in the currentAccountImpl lineage` };
  const own = x.rotations
    .filter((r) => same(r.subject, account) && same(r.writer, account) && BigInt(r.blockNumber) <= block)
    .sort((a, b) => (BigInt(a.blockNumber) === BigInt(b.blockNumber) ? a.logIndex - b.logIndex : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1));
  const last = own.at(-1);
  if (last) return { controller: getAddress(last.counterparty), from: "CONTROLLER_ROTATED", cite: cite(last) };
  if (x.factoryOwner) return { controller: getAddress(x.factoryOwner), from: "AccountCreated" };
  return { controller: null, reason: `${NOT_DETERMINABLE}: no AccountCreated from the permanent factory` };
}

// ── Self-dealing (R-D2B-3 as superseded by R-S189-4) ────────────────

export type Payment = { payee: Address; token: Address; value: bigint; block: bigint; cite: ReturnType<typeof cite> };

export type SelfDealingInput = {
  subject: Address;
  subjectController: ControllerInput;
  payments: Payment[];
  /** Per payee that is a NablaZ account on this chain: its controller input. */
  payeeControllers: Map<string, ControllerInput>;
  /** Payees that are the subject of at least one record entry. */
  payeesWithRecord: Set<string>;
};

export function selfDealing(x: SelfDealingInput) {
  const notes: string[] = [];
  const settlements = x.payments.length;
  const distinct = new Set(x.payments.map((p) => lc(p.payee))).size;
  if (!x.subjectController.canonicalImpl) {
    return {
      result: {
        distinctCounterparties: distinct,
        settlements,
        controller: NOT_DETERMINABLE,
        shareToSameController: null,
        shareToCounterpartiesWithoutRecord: null,
        sentence: SELF_DEALING_SENTENCE,
      },
      notes: [`controller history: ${NOT_DETERMINABLE} (implementation is not in the currentAccountImpl lineage); shares omitted`],
    };
  }
  // Shares are per token: values in different tokens are never summed.
  const byToken = new Map<string, { total: bigint; same: bigint; noRecord: bigint; undetermined: bigint }>();
  for (const p of x.payments) {
    const t = byToken.get(lc(p.token)) ?? { total: 0n, same: 0n, noRecord: 0n, undetermined: 0n };
    t.total += p.value;
    if (!x.payeesWithRecord.has(lc(p.payee))) t.noRecord += p.value;
    const payeeIn = x.payeeControllers.get(lc(p.payee));
    if (payeeIn) {
      const mine = controllerAt(x.subject, p.block, x.subjectController);
      const theirs = controllerAt(p.payee, p.block, payeeIn);
      if (mine.controller === null || theirs.controller === null) t.undetermined += p.value;
      else if (same(mine.controller, theirs.controller)) t.same += p.value;
    }
    byToken.set(lc(p.token), t);
  }
  const share = (n: bigint, d: bigint) => ({ value: n.toString(), total: d.toString(), share: d === 0n ? null : Number((n * 1_000_000n) / d) / 1_000_000 });
  const shareToSameController: Record<string, unknown> = {};
  const shareToCounterpartiesWithoutRecord: Record<string, unknown> = {};
  for (const [token, t] of byToken) {
    shareToSameController[token] = { ...share(t.same, t.total), ...(t.undetermined > 0n ? { notDeterminableValue: t.undetermined.toString() } : {}) };
    shareToCounterpartiesWithoutRecord[token] = share(t.noRecord, t.total);
    if (t.undetermined > 0n) notes.push(`same-controller share for ${token}: ${t.undetermined} paid to NablaZ accounts whose controller is ${NOT_DETERMINABLE}`);
  }
  if (settlements === 0) notes.push("no settled payment from this account in the indexed range");
  const c = controllerAt(x.subject, BigInt(Number.MAX_SAFE_INTEGER), x.subjectController);
  return {
    result: {
      distinctCounterparties: distinct,
      settlements,
      controller: c.controller ?? NOT_DETERMINABLE,
      shareToSameController,
      shareToCounterpartiesWithoutRecord,
      sentence: SELF_DEALING_SENTENCE,
    },
    notes,
  };
}

// ── Exposure (s3 §6.4a reader note) ─────────────────────────────────

export type ExposureGrant = {
  grantId: Hex;
  token: Address;
  /** grantOf(account, grantId).allowances[i].remaining for this token, one per window. */
  remaining: bigint[];
  vault: Address | null;
  vaultBalance: bigint | null;
};

export function exposure(canonicalMandate: boolean, grants: ExposureGrant[], asOfBlock: bigint) {
  if (!canonicalMandate)
    return {
      result: { computable: false, reason: `${NOT_DETERMINABLE}: dependencies().mandate is not CAM V4 by code hash`, outstandingAuthorizations: OUTSTANDING_AUTHORIZATIONS },
      notes: [`exposure: ${NOT_DETERMINABLE} (mandate is not CAM V4 by code hash)`],
    };
  const rows = grants.map((g) => {
    const window = g.remaining.length === 0 ? null : g.remaining.reduce((m, x) => (x < m ? x : m));
    return {
      grantId: g.grantId,
      token: g.token,
      minRemainingOverWindows: window?.toString() ?? null,
      vault: g.vault,
      vaultBalance: g.vaultBalance?.toString() ?? null,
      exposure: window === null ? null : (window + (g.vaultBalance ?? 0n)).toString(),
    };
  });
  return {
    result: { computable: true, asOfBlock: asOfBlock.toString(), grants: rows, outstandingAuthorizations: OUTSTANDING_AUTHORIZATIONS },
    notes: grants.length === 0 ? ["exposure: no GRANT_SET for this account in the indexed range"] : [],
  };
}

// ── Facts ───────────────────────────────────────────────────────────

/** Record entries: the account's own entries carry its NablaZ label; entries another writer placed are that writer's attestation. */
export function recordFacts(rows: Row[], nabla: NablaLabel | null): Fact[] {
  return rows.map((r) => {
    const own = same(r.writer, r.subject) && nabla !== null;
    return {
      source: "nablaz:record",
      label: own ? nabla!.label : attestationLabel(r.writer),
      shape: own ? nabla!.shape : "e",
      terms: plain(r, ["kindName", "kind", "writer", "writerAuth", "counterparty", "counterpartyAuth", "policyHash", "policyVersion", "asset", "amount", "obligationRef", "seq"]),
      cite: cite(r),
      reproduce: render("1-record-entries", { chainId: r.chainId, subject: r.subject }),
    };
  });
}

/** Vault payment pairs (R-S187-1) with the authorization chain (R-D2B-4). */
export function vaultPaymentFacts(rows: Row[], nabla: NablaLabel | null): Fact[] {
  return rows.map((r) => ({
    source: "nablaz:vault_payment",
    label: nabla?.label ?? LABEL.c,
    shape: nabla?.shape ?? "c",
    terms: {
      ...plain(r, ["vault", "payee", "value", "token", "nonce", "submitter", "transferLogIndex"]),
      authorization: plain(r, ["grantIdFromLogs", "fundingEntryId", "policyHash", "policyVersion", "envelopeStatus", "envelopeGrantId", "envelopeExpiry", "grantMatchesEnvelope"]),
      counts: { settlements: r.settlements, settlementOrdinalInTx: r.settlementOrdinalInTx, settlementsInTx: r.settlementsInTx, calls: str(r.calls), callsStatus: r.callsStatus },
    },
    cite: cite(r),
    reproduce: `${render("2-authorization-used", { chainId: r.chainId, vault: r.vault })}\n${render("2-vault-transfer", { chainId: r.chainId, vault: r.vault, tx: r.txHash })}`,
  }));
}

export function permissionFacts(rows: Row[]): Fact[] {
  return rows.map((r) => ({
    source: r.source === "spm" ? "coinbase:spend_permission" : "metamask:delegation",
    label: r.label,
    shape: r.shape,
    terms: { subject: r.subject, grantee: r.grantee, permissionId: r.permissionId, status: r.status, useCount: r.useCount, ...(r.terms as object) },
    cite: cite(r),
    reproduce: r.reproduce,
  }));
}

/** A payment's label is its permission's label. */
export function paymentFacts(rows: Row[], permissions: Map<string, Row>): Fact[] {
  return rows.map((r) => {
    const p = r.permissionId ? permissions.get(`${r.chainId}-${r.source === "spm" ? "spm" : "dm"}-${lc(r.permissionId)}`) : undefined;
    return {
      source: r.source === "spm" ? "coinbase:spend_permission_payment" : "metamask:delegation_payment",
      label: p?.label ?? LABEL.c,
      shape: p?.shape ?? "c",
      terms: {
        ...plain(r, ["payer", "payee", "token", "amount", "permissionId", "redemptionTx", "redemptionLogIndex"]),
        ...(p ? {} : { permission: `${NOT_DETERMINABLE}: permission row not indexed` }),
      },
      cite: cite(r),
      reproduce: r.reproduce,
    };
  });
}

/** The enforcers (nested groups included) that are in no vendor list the table is built from. */
export function unknownEnforcerReason(enforcers: unknown): string {
  const out: string[] = [];
  const walk = (cs: any[]) => {
    for (const c of cs ?? []) {
      if (c.name === null) out.push(c.enforcer);
      else if (c.class === null) out.push(`${c.name} (terms do not decode)`);
      for (const g of c.groups ?? []) walk(g);
    }
  };
  walk(enforcers as any[]);
  return out.length ? `enforcer not in the table: ${out.join(", ")}` : "a caveat group is not determinable";
}

export function redemptionFacts(rows: Row[]): Fact[] {
  return rows.map((r) => ({
    source: "metamask:redemption",
    label: r.label,
    shape: r.shape,
    terms: {
      ...plain(r, ["rootDelegator", "redeemer", "delegate", "delegator", "authority", "hop", "delegationHash", "hadTransfer"]),
      enforcers: r.enforcers,
      ...(r.shape === "c" ? { reason: unknownEnforcerReason(r.enforcers) } : {}),
      payment: r.hadTransfer ? "see the delegation_payment facts in this tx" : "none: no ERC-20 Transfer from the delegator in this tx (R-S189-5)",
    },
    cite: cite(r),
    reproduce: r.reproduce,
  }));
}

export function creditLineFacts(rows: Row[]): Fact[] {
  return rows.map((r) => ({
    source: "agent_credit_lines",
    label: r.label,
    shape: "e",
    terms: plain(r, ["lender", "agentId", "loanId", "kind", "party", "principal", "fee", "dueAt"]),
    cite: cite(r),
    reproduce: r.reproduce,
  }));
}

/** R-S189-6: one note per source that returned nothing, never omitted. */
export function emptySourceNotes(x: {
  chainId: number;
  hasNabla: boolean;
  /** Source groups this instance indexes (READER_SOURCES). */
  indexed: Set<"nabla" | "external">;
  lenders: number;
  counts: Record<string, number>;
  ranges: Record<string, string>;
}): string[] {
  const notes: string[] = [];
  const say = (key: string, text: string) => {
    if ((x.counts[key] ?? 0) === 0) notes.push(`${text}: empty (${x.ranges[key] ?? "indexed range"})`);
  };
  if (!x.hasNabla) notes.push(`no NablaZ source on chain ${x.chainId} (R-S189-1)`);
  else if (!x.indexed.has("nabla")) notes.push("NablaZ sources: not indexed by this instance (READER_SOURCES), so no NablaZ fact is reported");
  else {
    say("record", "NablaRecord entries about this address");
    say("vault_payment", "vault payments from this address");
  }
  if (!x.indexed.has("external")) {
    notes.push("third-party sources: not indexed by this instance (READER_SOURCES), so no SpendPermissionManager, DelegationManager or Agent Credit Lines fact is reported");
    return notes;
  }
  say("spm", "SpendPermissionManager permissions and spends for this address");
  say("dm", "DelegationManager redemptions naming this address");
  if (x.lenders === 0) notes.push("no Agent Credit Lines lender registered on this chain");
  else say("credit", "Agent Credit Lines events naming this address");
  return notes;
}

/** Every (c) label among the facts, stated as a note. */
export function notDeterminableNotes(facts: Fact[]): string[] {
  const out: string[] = [];
  for (const f of facts) {
    if (f.shape !== "c") continue;
    const reason = (f.terms as Row).reason ?? (f.terms as Row).permission ?? "";
    out.push(`${f.source} at block ${f.cite.block} tx ${f.cite.tx} log ${f.cite.logIndex}: ${LABEL.c}${reason ? ` (${reason})` : ""}`);
  }
  return out;
}
