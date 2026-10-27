// The MetaMask enforcer table (R-S189-3 AMENDED 2, R-S189-7): names and addresses parsed from the vendor's
// documents/Deployments.md at the pinned commit, classes from s3 §6.4c's 36-row table plus the five rows and
// the superseded row ruled in R-S189-7. Pure; no I/O.
// scripts/gen-enforcers.ts fetches the file and writes src/generated/enforcers.json from buildEnforcerTable.

import { getAddress, type Address } from "viem";

// R-S189-7: main at this commit, not the v1.3.0 tag. The file still heads its list "v1.3.0".
export const DEPLOYMENTS_SECTION = "v1.3.0";
export const DEPLOYMENTS_COMMIT = "b4b8c41fc912455a1af2300bfcd1276676b92a2e";
const rawUrl = (ref: string) => `https://raw.githubusercontent.com/MetaMask/delegation-framework/${ref}/documents/Deployments.md`;
export const DEPLOYMENTS_URL = rawUrl(DEPLOYMENTS_COMMIT);
/** The vendor-drift test (R-S189-8 (ii)) reads the moving branch. */
export const DEPLOYMENTS_MAIN_URL = rawUrl("refs/heads/main");

/** The tag the table was first pinned to; the superseded row's address is listed there. */
export const V1_3_0_COMMIT = "bfbdf9795a976833ed2fa000baf42fbb83958b03";
export const SUPERSEDED_NOTE = "superseded by vendor at b4b8c41f";

export type EnforcerClass = "amount" | "exact-call" | "call-term" | "scope-only" | "wrapper";
/** Balance-change enforcers carry one row per mode, read from the first byte of their terms. */
export type EnforcerMode = "decrease" | "increase" | null;
/** For an amount enforcer: how its terms bound the amount. */
export type AmountBasis = "total" | "per period" | "per period, per token" | "streamed" | "per call" | "per execution";

type ClassRow = { mode: EnforcerMode; class: EnforcerClass; amountBasis?: AmountBasis; singleUse?: true };

/**
 * Which terms layout decodes this row. SpecificActionERC20TransferBatchEnforcer changed layout between the
 * two addresses: 92-byte minimum at v1.3.0, 124 at b4b8c41f (a firstValue word was added).
 */
export type TermsLayout = "v1.3.0" | "b4b8c41f";

// The class column of s3 §6.4c at nablaz-protocol 4ace372840989469430996afd7f4668cab046e8e. One entry per
// enforcer name; balance-change enforcers have two rows.
const decreaseIncrease: ClassRow[] = [
  { mode: "decrease", class: "amount", amountBasis: "per execution" },
  { mode: "increase", class: "scope-only" },
];
export const CLASSES: Record<string, ClassRow[]> = {
  AllowedCalldataEnforcer: [{ mode: null, class: "call-term" }],
  AllowedMethodsEnforcer: [{ mode: null, class: "call-term" }],
  AllowedTargetsEnforcer: [{ mode: null, class: "call-term" }],
  BlockNumberEnforcer: [{ mode: null, class: "scope-only" }],
  DeployedEnforcer: [{ mode: null, class: "scope-only" }],
  ERC20BalanceChangeEnforcer: decreaseIncrease,
  ERC20TransferAmountEnforcer: [{ mode: null, class: "amount", amountBasis: "total" }],
  ERC20PeriodTransferEnforcer: [{ mode: null, class: "amount", amountBasis: "per period" }],
  ERC20StreamingEnforcer: [{ mode: null, class: "amount", amountBasis: "streamed" }],
  ERC721BalanceChangeEnforcer: decreaseIncrease,
  ERC721TransferEnforcer: [{ mode: null, class: "exact-call" }],
  ERC1155BalanceChangeEnforcer: decreaseIncrease,
  ExactCalldataBatchEnforcer: [{ mode: null, class: "exact-call" }],
  ExactCalldataEnforcer: [{ mode: null, class: "exact-call" }],
  ExactExecutionBatchEnforcer: [{ mode: null, class: "exact-call" }],
  ExactExecutionEnforcer: [{ mode: null, class: "exact-call" }],
  IdEnforcer: [{ mode: null, class: "scope-only" }],
  LogicalOrWrapperEnforcer: [{ mode: null, class: "wrapper" }],
  LimitedCallsEnforcer: [{ mode: null, class: "call-term" }],
  MultiTokenPeriodEnforcer: [{ mode: null, class: "amount", amountBasis: "per period, per token" }],
  NativeBalanceChangeEnforcer: decreaseIncrease,
  ArgsEqualityCheckEnforcer: [{ mode: null, class: "call-term" }],
  NativeTokenPaymentEnforcer: [{ mode: null, class: "scope-only" }],
  NativeTokenTransferAmountEnforcer: [{ mode: null, class: "amount", amountBasis: "total" }],
  NativeTokenStreamingEnforcer: [{ mode: null, class: "amount", amountBasis: "streamed" }],
  NativeTokenPeriodTransferEnforcer: [{ mode: null, class: "amount", amountBasis: "per period" }],
  NonceEnforcer: [{ mode: null, class: "scope-only" }],
  OwnershipTransferEnforcer: [{ mode: null, class: "exact-call" }],
  RedeemerEnforcer: [{ mode: null, class: "scope-only" }],
  // Single-use by its own source: usedDelegations, src/enforcers/SpecificActionERC20TransferBatchEnforcer.sol:26,
  // checked and set :71-76, at the pinned commit.
  SpecificActionERC20TransferBatchEnforcer: [{ mode: null, class: "exact-call", singleUse: true }],
  TimestampEnforcer: [{ mode: null, class: "scope-only" }],
  ValueLteEnforcer: [{ mode: null, class: "amount", amountBasis: "per call" }],
  // R-S189-7: the five rows added at b4b8c41f.
  ERC20MultiOperationIncreaseBalanceEnforcer: [{ mode: null, class: "scope-only" }],
  ERC721MultiOperationIncreaseBalanceEnforcer: [{ mode: null, class: "scope-only" }],
  ERC1155MultiOperationIncreaseBalanceEnforcer: [{ mode: null, class: "scope-only" }],
  NativeTokenMultiOperationIncreaseBalanceEnforcer: [{ mode: null, class: "scope-only" }],
  ApprovalRevocationEnforcer: [{ mode: null, class: "exact-call" }],
};

/**
 * R-S189-7: the SpecificActionERC20TransferBatchEnforcer address listed at v1.3.0 and replaced at b4b8c41f.
 * Still live on chain and still single-use (usedDelegations, :26, :71-76 at v1.3.0).
 */
export const SUPERSEDED = [
  {
    name: "SpecificActionERC20TransferBatchEnforcer",
    address: getAddress("0x00e0251aaA263dfE3B3541B758A82D1CBA1c3B6D"),
    listedAt: V1_3_0_COMMIT,
  },
] as const;

export type EnforcerRow = { name: string; address: Address; layout: TermsLayout; superseded?: string } & ClassRow;

export type EnforcerTable = {
  source: string;
  section: string;
  commit: string;
  rows: EnforcerRow[];
};

/** Every `<Name>Enforcer: 0x…` line of the file's v1.3.0 block, in file order. */
export function parseDeployments(markdown: string): { name: string; address: Address }[] {
  const start = markdown.indexOf(`### **${DEPLOYMENTS_SECTION}**`);
  if (start < 0) throw new Error(`Deployments.md has no ${DEPLOYMENTS_SECTION} section`);
  const out: { name: string; address: Address }[] = [];
  for (const m of markdown.slice(start).matchAll(/^([A-Za-z0-9]+Enforcer):\s*(0x[0-9a-fA-F]{40})\s*$/gm)) {
    out.push({ name: m[1]!, address: getAddress(m[2]!) });
  }
  return out;
}

/** Refuses a parsed enforcer with no class, and a class with no parsed enforcer. */
export function buildEnforcerTable(markdown: string): EnforcerTable {
  const parsed = parseDeployments(markdown);
  const names = new Set(parsed.map((p) => p.name));
  for (const n of Object.keys(CLASSES)) if (!names.has(n)) throw new Error(`class for ${n}, absent from Deployments.md`);
  const rows: EnforcerRow[] = [];
  for (const p of parsed) {
    const classes = CLASSES[p.name];
    if (!classes) throw new Error(`${p.name} in Deployments.md has no class`);
    for (const c of classes) rows.push({ ...p, layout: "b4b8c41f", ...c });
  }
  for (const s of SUPERSEDED) {
    if (parsed.some((p) => p.address === s.address)) throw new Error(`${s.address} is listed again; it is no longer superseded`);
    for (const c of CLASSES[s.name]!) rows.push({ name: s.name, address: s.address, layout: "v1.3.0", superseded: SUPERSEDED_NOTE, ...c });
  }
  return { source: DEPLOYMENTS_URL, section: DEPLOYMENTS_SECTION, commit: DEPLOYMENTS_COMMIT, rows };
}

export function serializeEnforcerTable(t: EnforcerTable): string {
  return `${JSON.stringify(t, null, 2)}\n`;
}
