// MetaMask DelegationManager v1.3.0: event decoding, delegation hash, caveat terms. Pure; no I/O.
// Layouts are read from the vendor's source at bfbdf9795a976833ed2fa000baf42fbb83958b03 (v1.3.0):
// src/interfaces/IDelegationManager.sol:14 (event), src/utils/Types.sol:24-42 (structs),
// src/libraries/EncoderLib.sol (hash), src/enforcers/<Name>.sol getTermsInfo (terms). Enforcers added or
// changed at b4b8c41fc912455a1af2300bfcd1276676b92a2e (R-S189-7) are read at that commit.

import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  keccak256,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import tableJson from "./generated/enforcers.json" with { type: "json" };
import type { EnforcerClass, EnforcerMode, EnforcerRow, EnforcerTable, TermsLayout } from "./enforcer-table.ts";

export const ENFORCER_TABLE = tableJson as EnforcerTable;

export const DelegationManagerAbi = parseAbi([
  "struct Caveat { address enforcer; bytes terms; bytes args; }",
  "struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }",
  "event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, Delegation delegation)",
]);

export const ROOT_AUTHORITY: Hex = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
/** DelegationManager.ANY_DELEGATE (src/DelegationManager.sol:41). */
export const ANY_DELEGATE: Address = "0x0000000000000000000000000000000000000a11";

export type Caveat = { enforcer: Address; terms: Hex; args: Hex };
export type Delegation = {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: readonly Caveat[];
  salt: bigint;
  signature: Hex;
};
export type Redemption = { rootDelegator: Address; redeemer: Address; delegation: Delegation };

export function decodeRedeemedDelegation(log: { topics: readonly Hex[]; data: Hex }): Redemption {
  const { args } = decodeEventLog({
    abi: DelegationManagerAbi,
    eventName: "RedeemedDelegation",
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  });
  return args as Redemption;
}

const DELEGATION_TYPEHASH = keccak256(
  stringToHex(
    "Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)",
  ),
);
const CAVEAT_TYPEHASH = keccak256(stringToHex("Caveat(address enforcer,bytes terms)"));

/** EncoderLib._getDelegationHash: signature and caveat args are not hashed. */
export function delegationHash(d: Delegation): Hex {
  const caveatHashes = d.caveats.map((c) =>
    keccak256(encodeAbiParameters(parseAbiParameters("bytes32, address, bytes32"), [CAVEAT_TYPEHASH, c.enforcer, keccak256(c.terms)])),
  );
  const caveatsHash = keccak256(caveatHashes.length === 0 ? "0x" : (`0x${caveatHashes.map((h) => h.slice(2)).join("")}` as Hex));
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, address, bytes32, bytes32, uint256"), [
      DELEGATION_TYPEHASH,
      d.delegate,
      d.delegator,
      d.authority,
      caveatsHash,
      d.salt,
    ]),
  );
}

/**
 * Which delegation of a chain this event carries. DelegationManager emits one RedeemedDelegation per
 * delegation in the chain, leaf first, each with the root's delegator as topic1 (src/DelegationManager.sol:298-304).
 * Root: authority = ROOT_AUTHORITY. Otherwise the authority is the hash of its parent in the chain.
 */
export function hopOf(d: Delegation): "root" | "child" {
  return d.authority.toLowerCase() === ROOT_AUTHORITY ? "root" : "child";
}

// ── Caveat terms ────────────────────────────────────────────────────

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

const addr = (h: Hex, from: number, to: number) => getAddress(slice(h, from, to));
const uint = (h: Hex, from: number, to?: number) => hexToBigInt(slice(h, from, to));

/** An ERC-20 transfer(address,uint256) inside a call, if the calldata is one. */
function erc20TransferIn(callData: Hex): { to: Address; amount: string } | undefined {
  if (size(callData) !== 68 || slice(callData, 0, 4).toLowerCase() !== ERC20_TRANSFER_SELECTOR) return undefined;
  const [to, amount] = decodeAbiParameters(parseAbiParameters("address, uint256"), slice(callData, 4));
  return { to, amount: amount.toString() };
}

function execution(target: Address, value: bigint, callData: Hex) {
  const transfer = erc20TransferIn(callData);
  return { target, value: value.toString(), callData, ...(transfer ? { erc20Transfer: { token: target, ...transfer } } : {}) };
}

const singleExecution = (t: Hex) => execution(addr(t, 0, 20), uint(t, 20, 52), size(t) > 52 ? slice(t, 52) : "0x");
const batchExecutions = (t: Hex) =>
  decodeAbiParameters(parseAbiParameters("(address target, uint256 value, bytes callData)[]"), t)[0].map((e) =>
    execution(e.target, e.value, e.callData),
  );

const addressList = (t: Hex) => {
  const out: Address[] = [];
  for (let i = 0; i < size(t); i += 20) out.push(addr(t, i, i + 20));
  return out;
};

/** getTermsInfo of each enforcer, by name. Amounts are decimal strings so the result is JSON. */
const TERMS: Record<string, (t: Hex) => Record<string, unknown>> = {
  AllowedCalldataEnforcer: (t) => ({ dataStart: uint(t, 0, 32).toString(), value: slice(t, 32) }),
  AllowedMethodsEnforcer: (t) => {
    const out: Hex[] = [];
    for (let i = 0; i < size(t); i += 4) out.push(slice(t, i, i + 4));
    return { methods: out };
  },
  AllowedTargetsEnforcer: (t) => ({ targets: addressList(t) }),
  ArgsEqualityCheckEnforcer: (t) => ({ expectedArgs: t }),
  BlockNumberEnforcer: (t) => ({ afterBlock: uint(t, 0, 16).toString(), beforeBlock: uint(t, 16, 32).toString() }),
  DeployedEnforcer: (t) => ({ expectedAddress: addr(t, 0, 20), salt: slice(t, 20, 52) }),
  ERC20BalanceChangeEnforcer: (t) => ({
    enforceDecrease: uint(t, 0, 1) !== 0n,
    token: addr(t, 1, 21),
    recipient: addr(t, 21, 41),
    amount: uint(t, 41, 73).toString(),
  }),
  ERC20TransferAmountEnforcer: (t) => ({ token: addr(t, 0, 20), maxTokens: uint(t, 20, 52).toString() }),
  ERC20PeriodTransferEnforcer: (t) => ({
    token: addr(t, 0, 20),
    periodAmount: uint(t, 20, 52).toString(),
    periodDuration: uint(t, 52, 84).toString(),
    startDate: uint(t, 84, 116).toString(),
  }),
  ERC20StreamingEnforcer: (t) => ({
    token: addr(t, 0, 20),
    initialAmount: uint(t, 20, 52).toString(),
    maxAmount: uint(t, 52, 84).toString(),
    amountPerSecond: uint(t, 84, 116).toString(),
    startTime: uint(t, 116, 148).toString(),
  }),
  ERC721BalanceChangeEnforcer: (t) => ({
    enforceDecrease: uint(t, 0, 1) !== 0n,
    token: addr(t, 1, 21),
    recipient: addr(t, 21, 41),
    amount: uint(t, 41, 73).toString(),
  }),
  ERC721TransferEnforcer: (t) => ({ token: addr(t, 0, 20), tokenId: uint(t, 20, 52).toString() }),
  ERC1155BalanceChangeEnforcer: (t) => ({
    enforceDecrease: uint(t, 0, 1) !== 0n,
    token: addr(t, 1, 21),
    recipient: addr(t, 21, 41),
    tokenId: uint(t, 41, 73).toString(),
    amount: uint(t, 73, 105).toString(),
  }),
  ExactCalldataBatchEnforcer: (t) => ({ executions: batchExecutions(t) }),
  ExactCalldataEnforcer: (t) => ({ callData: t, ...(erc20TransferIn(t) ? { erc20Transfer: erc20TransferIn(t) } : {}) }),
  ExactExecutionBatchEnforcer: (t) => ({ executions: batchExecutions(t) }),
  ExactExecutionEnforcer: (t) => singleExecution(t),
  IdEnforcer: (t) => ({ id: uint(t, 0, 32).toString() }),
  LimitedCallsEnforcer: (t) => ({ limit: uint(t, 0, 32).toString() }),
  MultiTokenPeriodEnforcer: (t) => {
    const periods = [];
    for (let o = 0; o < size(t); o += 116) {
      periods.push({
        token: addr(t, o, o + 20),
        periodAmount: uint(t, o + 20, o + 52).toString(),
        periodDuration: uint(t, o + 52, o + 84).toString(),
        startDate: uint(t, o + 84, o + 116).toString(),
      });
    }
    return { periods };
  },
  NativeBalanceChangeEnforcer: (t) => ({
    enforceDecrease: uint(t, 0, 1) !== 0n,
    recipient: addr(t, 1, 21),
    amount: uint(t, 21, 53).toString(),
  }),
  NativeTokenPaymentEnforcer: (t) => ({ recipient: addr(t, 0, 20), amount: uint(t, 20, 52).toString() }),
  NativeTokenPeriodTransferEnforcer: (t) => ({
    periodAmount: uint(t, 0, 32).toString(),
    periodDuration: uint(t, 32, 64).toString(),
    startDate: uint(t, 64, 96).toString(),
  }),
  NativeTokenStreamingEnforcer: (t) => ({
    initialAmount: uint(t, 0, 32).toString(),
    maxAmount: uint(t, 32, 64).toString(),
    amountPerSecond: uint(t, 64, 96).toString(),
    startTime: uint(t, 96, 128).toString(),
  }),
  NativeTokenTransferAmountEnforcer: (t) => ({ allowance: uint(t, 0, 32).toString() }),
  NonceEnforcer: (t) => ({ nonce: uint(t, 0, 32).toString() }),
  OwnershipTransferEnforcer: (t) => ({ target: addr(t, 0, 20) }),
  RedeemerEnforcer: (t) => ({ redeemers: addressList(t) }),
  // v1.3.0 layout (the superseded address); the b4b8c41f layout is in TERMS_B4B8 below.
  SpecificActionERC20TransferBatchEnforcer: (t) => {
    if (size(t) < 92) throw new Error("terms shorter than 92 bytes");
    return {
      token: addr(t, 0, 20),
      recipient: addr(t, 20, 40),
      amount: uint(t, 40, 72).toString(),
      firstTarget: addr(t, 72, 92),
      firstCalldata: size(t) > 92 ? slice(t, 92) : "0x",
    };
  },
  TimestampEnforcer: (t) => ({ afterTimestamp: uint(t, 0, 16).toString(), beforeTimestamp: uint(t, 16, 32).toString() }),
  ValueLteEnforcer: (t) => ({ maxValue: uint(t, 0, 32).toString() }),
  ERC20MultiOperationIncreaseBalanceEnforcer: (t) => ({
    token: addr(t, 0, 20),
    recipient: addr(t, 20, 40),
    minIncrease: uint(t, 40, 72).toString(),
  }),
  ERC721MultiOperationIncreaseBalanceEnforcer: (t) => ({
    token: addr(t, 0, 20),
    recipient: addr(t, 20, 40),
    minIncrease: uint(t, 40, 72).toString(),
  }),
  ERC1155MultiOperationIncreaseBalanceEnforcer: (t) => ({
    token: addr(t, 0, 20),
    recipient: addr(t, 20, 40),
    tokenId: uint(t, 40, 72).toString(),
    minIncrease: uint(t, 72, 104).toString(),
  }),
  NativeTokenMultiOperationIncreaseBalanceEnforcer: (t) => ({ recipient: addr(t, 0, 20), minIncrease: uint(t, 20, 52).toString() }),
  // A 1-byte bitmask of the revocation primitives allowed (src/enforcers/ApprovalRevocationEnforcer.sol:14-24, :318-322).
  ApprovalRevocationEnforcer: (t) => {
    if (size(t) !== 1) throw new Error("terms are not 1 byte");
    const flags = Number(uint(t, 0, 1));
    const names = ["erc20Approve0", "erc721ApproveZero", "setApprovalForAllFalse", "permit2Approve0", "permit2Lockdown", "permit2InvalidateNonces"];
    return { flags, allowed: names.filter((_, i) => (flags >> i) & 1) };
  },
};

/** Layout overrides at b4b8c41f, by name. */
const TERMS_B4B8: Record<string, (t: Hex) => Record<string, unknown>> = {
  // src/enforcers/SpecificActionERC20TransferBatchEnforcer.sol getTermsInfo at b4b8c41f: firstValue added.
  SpecificActionERC20TransferBatchEnforcer: (t) => {
    if (size(t) < 124) throw new Error("terms shorter than 124 bytes");
    return {
      token: addr(t, 0, 20),
      recipient: addr(t, 20, 40),
      amount: uint(t, 40, 72).toString(),
      firstTarget: addr(t, 72, 92),
      firstValue: uint(t, 92, 124).toString(),
      firstCalldata: size(t) > 124 ? slice(t, 124) : "0x",
    };
  },
};

const termsDecoder = (name: string, layout: TermsLayout) => (layout === "b4b8c41f" && TERMS_B4B8[name]) || TERMS[name]!;

/** LogicalOrWrapperEnforcer terms: CaveatGroup[] (src/enforcers/LogicalOrWrapperEnforcer.sol:61, decode :251). */
export function decodeCaveatGroups(terms: Hex): Caveat[][] {
  const [groups] = decodeAbiParameters(
    parseAbiParameters("((address enforcer, bytes terms, bytes args)[] caveats)[]"),
    terms,
  );
  return groups.map((g) => g.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })));
}

export type DecodedCaveat = {
  enforcer: Address;
  /** Null: the address is not in the pinned table. */
  name: string | null;
  /** Set on the superseded row (R-S189-7). */
  superseded?: string;
  class: EnforcerClass | null;
  mode: EnforcerMode;
  terms: Record<string, unknown> | null;
  /** Set when the terms do not decode by the enforcer's own layout. */
  termsError?: string;
  /** LogicalOrWrapper only. */
  groups?: DecodedCaveat[][];
};

/** The table rows for an address (one, or two for a balance-change enforcer). */
export function rowsFor(enforcer: Address, table: EnforcerTable = ENFORCER_TABLE): EnforcerRow[] {
  const a = enforcer.toLowerCase();
  return table.rows.filter((r) => r.address.toLowerCase() === a);
}

/** Name, class (by mode where the class depends on it) and decoded terms of one caveat. */
export function decodeCaveat(c: Caveat, table: EnforcerTable = ENFORCER_TABLE): DecodedCaveat {
  const rows = rowsFor(c.enforcer, table);
  const base = { enforcer: getAddress(c.enforcer) };
  if (rows.length === 0) return { ...base, name: null, class: null, mode: null, terms: null };
  const name = rows[0]!.name;
  const tag = rows[0]!.superseded ? { superseded: rows[0]!.superseded } : {};
  if (name === "LogicalOrWrapperEnforcer") {
    try {
      const groups = decodeCaveatGroups(c.terms).map((g) => g.map((x) => decodeCaveat(x, table)));
      return { ...base, name, class: "wrapper", mode: null, terms: { groups: groups.length }, groups };
    } catch (e) {
      return { ...base, name, class: "wrapper", mode: null, terms: null, termsError: (e as Error).message };
    }
  }
  let terms: Record<string, unknown>;
  try {
    terms = termsDecoder(name, rows[0]!.layout)(c.terms);
  } catch (e) {
    // A class decided by mode cannot be decided without the terms.
    const fixed = rows.length === 1 ? rows[0]! : null;
    return { ...base, name, ...tag, class: fixed?.class ?? null, mode: null, terms: null, termsError: (e as Error).message };
  }
  if (rows.length === 1) return { ...base, name, ...tag, class: rows[0]!.class, mode: null, terms };
  const mode: EnforcerMode = terms.enforceDecrease ? "decrease" : "increase";
  const row = rows.find((r) => r.mode === mode)!;
  return { ...base, name, ...tag, class: row.class, mode, terms };
}

export function amountBasisOf(name: string, mode: EnforcerMode, table: EnforcerTable = ENFORCER_TABLE) {
  return table.rows.find((r) => r.name === name && r.mode === mode)?.amountBasis;
}

export function isSingleUse(name: string, table: EnforcerTable = ENFORCER_TABLE): boolean {
  return table.rows.some((r) => r.name === name && r.singleUse === true);
}

// ── Payments in the same transaction (R-S189-5) ─────────────────────

export const TRANSFER_TOPIC: Hex = keccak256(stringToHex("Transfer(address,address,uint256)"));

export type ReceiptLogLike = { address: Address; topics: readonly Hex[]; data: Hex; logIndex: number };

/**
 * ERC-20 Transfer logs in a receipt whose `from` is one of `froms`. ERC-721 Transfer shares topic0 but
 * indexes the token id as a fourth topic, so only three-topic logs count.
 */
export function erc20TransfersFrom(logs: readonly ReceiptLogLike[], froms: readonly Address[]) {
  const set = new Set(froms.map((f) => f.toLowerCase()));
  return logs
    .filter((l) => l.topics.length === 3 && l.topics[0] === TRANSFER_TOPIC)
    .map((l) => ({
      token: getAddress(l.address),
      from: getAddress(slice(l.topics[1]!, 12)),
      to: getAddress(slice(l.topics[2]!, 12)),
      amount: l.data === "0x" ? 0n : hexToBigInt(l.data),
      logIndex: l.logIndex,
    }))
    .filter((t) => set.has(t.from.toLowerCase()));
}
