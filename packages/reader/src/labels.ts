// Permission labels: R-S189-3 AMENDED 2 (shapes, precedence), AMENDED 3 (rendering of (b)) and R-S189-7
// (ApprovalRevocationEnforcer), s3 §6.4a and §6.4c at nablaz-protocol 4ace372840989469430996afd7f4668cab046e8e.
// Pure; no I/O.

import type { Address, Hex } from "viem";
import { ENFORCER_TABLE, amountBasisOf, decodeCaveat, isSingleUse, type Caveat, type DecodedCaveat } from "./delegation.ts";
import type { AmountBasis, EnforcerTable } from "./enforcer-table.ts";
import lineageJson from "./generated/account-lineage.json" with { type: "json" };

const BASIS_ORDER: AmountBasis[] = ["total", "per period", "per period, per token", "streamed", "per call", "per execution"];

export type Shape = "a" | "b" | "c" | "d" | "e";

export const LABEL = {
  a: "(a) allowance",
  bOnce: "(b) exact execution, once",
  bTimes: (n: bigint) => `(b) exact execution, ${n} times`,
  bUnbounded: "(b) exact execution, count unbounded",
  bApprovalRevocation: "(b) exact execution: approval revocation, no value",
  c: "(c) not determinable",
  d: "(d) no limit on amount or call",
  e: "(e) third-party attestation, writer named",
  withinMandate: "(a) within mandate by construction",
} as const;

/** N for shape (b): a number, or no count bound. */
export type Count = bigint | "unbounded";

export type ShapeResult = {
  shape: Shape;
  label: string;
  /** (b) only. */
  count?: Count;
  /** (a) only: how each amount enforcer bounds the amount. */
  bases?: string[];
  /** (c) only: why. */
  reason?: string;
  /** LogicalOrWrapper: one result per caveat set the redeemer can pick. */
  anyOf?: ShapeResult[];
};

/** AMENDED 3: "once" for N = 1, "N times" for N ≥ 2, "count unbounded" otherwise. */
export function renderB(count: Count): string {
  if (count === "unbounded") return LABEL.bUnbounded;
  return count === 1n ? LABEL.bOnce : LABEL.bTimes(count);
}

/** Every caveat set the redeemer can end up under: the top-level caveats plus one group of each wrapper. */
function expand(cs: readonly DecodedCaveat[]): DecodedCaveat[][] {
  const wrapper = cs.find((c) => c.class === "wrapper" && c.groups);
  if (!wrapper) return [cs.slice()];
  const rest = cs.filter((c) => c !== wrapper);
  return wrapper.groups!.flatMap((g) => expand([...rest, ...g]));
}

/** Precedence (1)–(4) of R-S189-3 AMENDED 2 over one caveat set with no decodable wrapper left in it. */
function shapeOfFlat(cs: readonly DecodedCaveat[], table: EnforcerTable): ShapeResult {
  // (1) any enforcer absent from the table.
  const unknown = cs.find((c) => c.name === null);
  if (unknown) return { shape: "c", label: LABEL.c, reason: `enforcer ${unknown.enforcer} is in no vendor list the table is built from (${table.commit})` };
  const undecided = cs.find((c) => c.class === null);
  if (undecided) return { shape: "c", label: LABEL.c, reason: `${undecided.name} terms do not decode, so its mode is unknown` };
  if (cs.some((c) => c.class === "wrapper")) return { shape: "c", label: LABEL.c, reason: "LogicalOrWrapperEnforcer terms do not decode" };

  // (2) any exact-call enforcer.
  const exact = cs.filter((c) => c.class === "exact-call");
  if (exact.length > 0) {
    const limits = cs.filter((c) => c.name === "LimitedCallsEnforcer" && c.terms).map((c) => BigInt(c.terms!.limit as string));
    // SpecificActionERC20TransferBatchEnforcer records its own use (usedDelegations, :26, :71-76 at v1.3.0;
    // :26, :73-78 at b4b8c41f), so N ≤ 1 wherever it is present.
    if (exact.some((c) => isSingleUse(c.name!, table))) limits.push(1n);
    const count: Count = limits.length === 0 ? "unbounded" : limits.reduce((m, x) => (x < m ? x : m));
    // R-S189-7: a set whose only exact-call enforcer is ApprovalRevocationEnforcer has its own rendering.
    const label = exact.every((c) => c.name === "ApprovalRevocationEnforcer") ? LABEL.bApprovalRevocation : renderB(count);
    return { shape: "b", label, count };
  }

  // (3) any amount enforcer. Bases in a fixed order, so equal terms give equal labels whatever the caveat order.
  const amounts = cs.filter((c) => c.class === "amount");
  if (amounts.length > 0) {
    const bases = [...new Set(amounts.map((c) => amountBasisOf(c.name!, c.mode, table)!))].sort((x, y) => BASIS_ORDER.indexOf(x) - BASIS_ORDER.indexOf(y));
    return { shape: "a", label: `${LABEL.a}, ${bases.join(", ")}`, bases };
  }

  // (4) call-term and scope-only alone.
  return { shape: "d", label: LABEL.d };
}

/** LogicalOrWrapperEnforcer takes the weakest group: (d) if any, else (c) if any, else any of {…}. */
function weakest(results: ShapeResult[]): ShapeResult {
  if (results.length === 1) return results[0]!;
  const d = results.find((r) => r.shape === "d");
  if (d) return { ...d, anyOf: results };
  const c = results.find((r) => r.shape === "c");
  if (c) return { ...c, anyOf: results };
  const labels = [...new Set(results.map((r) => r.label))];
  if (labels.length === 1) return { ...results[0]!, anyOf: results };
  return { shape: results[0]!.shape, label: `any of {${labels.join("; ")}}`, anyOf: results };
}

export function shapeOfDecoded(cs: readonly DecodedCaveat[], table: EnforcerTable = ENFORCER_TABLE): ShapeResult {
  return weakest(expand(cs).map((set) => shapeOfFlat(set, table)));
}

/** The shape of a MetaMask delegation from its whole caveat set. */
export function shapeOfDelegation(caveats: readonly Caveat[], table: EnforcerTable = ENFORCER_TABLE) {
  const decoded = caveats.map((c) => decodeCaveat(c, table));
  return { ...shapeOfDecoded(decoded, table), enforcers: decoded };
}

/** JSON form of a ShapeResult (count as a string). */
export function shapeJson(r: ShapeResult): Record<string, unknown> {
  return {
    shape: r.shape,
    label: r.label,
    ...(r.count !== undefined ? { count: r.count === "unbounded" ? "count unbounded" : r.count.toString() } : {}),
    ...(r.bases ? { bases: r.bases } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.anyOf ? { anyOf: r.anyOf.map(shapeJson) } : {}),
  };
}

// ── Coinbase SpendPermissionManager: (a), per period ───────────────

export type SpendPermission = {
  account: Address;
  spender: Address;
  token: Address;
  allowance: bigint;
  period: number;
  start: number;
  end: number;
  salt: bigint;
  extraData: Hex;
};

export const SPM_LABEL = `${LABEL.a}, per period`;

export function shapeOfSpm(p: SpendPermission) {
  return {
    shape: "a" as const,
    label: SPM_LABEL,
    terms: { allowance: p.allowance.toString(), period: p.period, start: p.start, end: p.end, token: p.token },
  };
}

// ── (e) third-party attestation ────────────────────────────────────

export function attestationLabel(writer: Address): string {
  return `${LABEL.e}: ${writer}`;
}

// ── NablaZ account ─────────────────────────────────────────────────

/** The currentAccountImpl lineage, oldest first (src/generated/account-lineage.json, R-S189-4 AMENDED 2). */
export const CURRENT_ACCOUNT_IMPL_LINEAGE: readonly Address[] = lineageJson.lineage.map((l) => l.address as Address);
/** NablaAccountBootstrap, from the same file. */
export const NABLA_ACCOUNT_BOOTSTRAP = lineageJson.bootstrap.address as Address;
/** ProtocolConfig, from the same file. */
export const PROTOCOL_CONFIG = lineageJson.protocolConfig.address as Address;

/**
 * The sub-label "within mandate by construction" only when the implementation is in the currentAccountImpl
 * lineage per its Upgraded events and dependencies().mandate's code hash equals CAM V4's.
 */
export type NablaCanonicalInput = {
  /** Every implementation the account has had, per Upgraded events, oldest first. */
  implementations: readonly Address[];
  /** Implementations ProtocolConfig has published as currentAccountImpl. Default: CURRENT_ACCOUNT_IMPL_LINEAGE. */
  lineage?: readonly Address[];
  /** The factory's bootstrap implementation: allowed only as the first Upgraded of an account. Default: NABLA_ACCOUNT_BOOTSTRAP. */
  bootstrap?: Address;
  /** extcodehash of dependencies().mandate, or null if it could not be read. */
  mandateCodeHash: Hex | null;
  camV4CodeHash: Hex;
};

export type NablaLabel = { shape: "a" | "c"; label: string; canonicalImpl: boolean; reason?: string };

export function canonicalLineage(x: Pick<NablaCanonicalInput, "implementations" | "lineage" | "bootstrap">): { ok: boolean; reason?: string } {
  const lineage = new Set((x.lineage ?? CURRENT_ACCOUNT_IMPL_LINEAGE).map((a) => a.toLowerCase()));
  const bootstrap = (x.bootstrap ?? NABLA_ACCOUNT_BOOTSTRAP).toLowerCase();
  if (x.implementations.length === 0) return { ok: false, reason: "no Upgraded event seen for the account" };
  for (const [i, impl] of x.implementations.entries()) {
    if (i === 0 && impl.toLowerCase() === bootstrap) continue;
    if (!lineage.has(impl.toLowerCase())) return { ok: false, reason: `implementation ${impl} is not in the currentAccountImpl lineage` };
  }
  if (x.implementations.length === 1 && x.implementations[0]!.toLowerCase() === bootstrap)
    return { ok: false, reason: "the account never left its bootstrap implementation" };
  return { ok: true };
}

export function nablaLabel(x: NablaCanonicalInput): NablaLabel {
  const lin = canonicalLineage(x);
  if (!lin.ok) return { shape: "c", label: LABEL.c, canonicalImpl: false, reason: lin.reason };
  if (x.mandateCodeHash === null)
    return { shape: "c", label: LABEL.c, canonicalImpl: true, reason: "dependencies().mandate could not be read" };
  if (x.mandateCodeHash.toLowerCase() !== x.camV4CodeHash.toLowerCase())
    return { shape: "c", label: LABEL.c, canonicalImpl: true, reason: "dependencies().mandate code hash is not CAM V4's" };
  return { shape: "a", label: LABEL.withinMandate, canonicalImpl: true };
}
