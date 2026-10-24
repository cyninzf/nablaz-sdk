// Pure derivations shared by the Ponder handlers and the tests. No I/O.

import {
  concat,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  numberToHex,
  pad,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";

// ── Kinds ───────────────────────────────────────────────────────────

export const KIND_NAMES = [
  "ACCOUNT_OPENED",
  "CONTROLLER_ROTATED",
  "IMPLEMENTATION_CHANGED",
  "DEPENDENCY_SET",
  "GRANT_SET",
  "GRANT_REVOKED",
  "KILL_SWITCH",
  "PAY",
  "APPROVE",
  "PAY_AUTHORIZED",
  "OBLIGATION_OPENED",
  "REPAY",
  "OBLIGATION_CLOSED",
  "DEPOSIT",
  "WITHDRAW",
  "ENCUMBER",
  "RELEASE",
  "PROOF_ACCEPTED",
  "EXTERNAL_ATTESTATION",
  "REFUSED",
] as const;
export type KindName = (typeof KIND_NAMES)[number];

/** kind = keccak256 of the kind name. */
export const KIND: Record<KindName, Hex> = Object.fromEntries(
  KIND_NAMES.map((n) => [n, keccak256(stringToHex(n))]),
) as Record<KindName, Hex>;

const KIND_BY_HASH = new Map<Hex, KindName>(KIND_NAMES.map((n) => [KIND[n], n]));

/** The kind's name, or null for a hash that is not a known kind. */
export function kindName(kind: Hex): KindName | null {
  return KIND_BY_HASH.get(kind.toLowerCase() as Hex) ?? null;
}

export const OBLIGATION_KINDS = new Set<KindName>(["OBLIGATION_OPENED", "REPAY", "OBLIGATION_CLOSED"]);

/**
 * Kinds whose `counterparty` is the other side of a value movement or commitment. Configuration kinds
 * (grants, dependencies, implementation, controller) carry a grantee or a contract there, and
 * PAY_AUTHORIZED carries the grantee of a funding, so none of those count as counterparties.
 */
export const COUNTERPARTY_KINDS = new Set<KindName>([
  "PAY",
  "APPROVE",
  "OBLIGATION_OPENED",
  "REPAY",
  "OBLIGATION_CLOSED",
  "DEPOSIT",
  "WITHDRAW",
  "EXTERNAL_ATTESTATION",
]);

/** DEPENDENCY_SET.writerAuth field id for the mandate. */
export const DEPENDENCY_FIELD_MANDATE: Hex = pad("0x0", { size: 32 });

// ── Obligations ─────────────────────────────────────────────────────

export const ZERO32: Hex = pad("0x0", { size: 32 });

export type ObligationRole = "OPENED" | "REPAY" | "CLOSED";

export function obligationRole(kind: KindName): ObligationRole | null {
  if (kind === "OBLIGATION_OPENED") return "OPENED";
  if (kind === "REPAY") return "REPAY";
  if (kind === "OBLIGATION_CLOSED") return "CLOSED";
  return null;
}

// ── Grantee key and vault address ───────────────────────────────────

/** CAM V4 granteeKeyOf: agentId grants key by agentId, address grants by the grantee. Pure. */
export function granteeKeyOf(grantee: Address, agentId: bigint): Hex {
  return agentId !== 0n
    ? keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [1, agentId]))
    : keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [0, grantee]));
}

/**
 * The vault the account deploys for `granteeKey`: an EIP-1167 clone of `vaultImpl` with immutable args
 * `(account, granteeKey)`, salt `granteeKey`, deployer `account` (OpenZeppelin Clones layout).
 */
export function predictVault(vaultImpl: Address, account: Address, granteeKey: Hex): Address {
  const args = encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [account, granteeKey]);
  const argsLen = (args.length - 2) / 2;
  const initCode = concat([
    "0x61",
    numberToHex(argsLen + 0x2d, { size: 2 }),
    "0x3d81600a3d39f3363d3d373d3d3d363d73",
    vaultImpl,
    "0x5af43d82803e903d91602b57fd5bf3",
    args,
  ]);
  return getContractAddress({ opcode: "CREATE2", from: account, salt: granteeKey, bytecode: initCode });
}

export function bytes32ToAddress(b: Hex): Address {
  return getAddress(`0x${b.slice(-40)}`);
}

// ── Settlement pairing (P0-1) ───────────────────────────────────────

export const TRANSFER_TOPIC: Hex = keccak256(stringToHex("Transfer(address,address,uint256)"));
export const AUTHORIZATION_USED_TOPIC: Hex = keccak256(stringToHex("AuthorizationUsed(address,bytes32)"));

export type ReceiptLog = { address: Address; topics: readonly Hex[]; data: Hex; logIndex: number };

const topicAddress = (t: Hex | undefined) => (t ? bytes32ToAddress(t) : null);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The token Transfer that settles the AuthorizationUsed at `authLogIndex`: the first Transfer from the
 * vault after it in the same receipt. Observed in Phase 0 (P0-1): USDC emits AuthorizationUsed, then the
 * Transfer, adjacent.
 */
export function pairTransfer(logs: readonly ReceiptLog[], token: Address, vault: Address, authLogIndex: number) {
  const t = [...logs]
    .sort((a, b) => a.logIndex - b.logIndex)
    .find(
      (l) =>
        l.logIndex > authLogIndex &&
        same(l.address, token) &&
        l.topics[0] === TRANSFER_TOPIC &&
        same(topicAddress(l.topics[1]) ?? "", vault),
    );
  if (!t) return null;
  return { logIndex: t.logIndex, to: topicAddress(t.topics[2])!, value: BigInt(t.data), topics: t.topics };
}

/**
 * R-D2B-6 settlements: one per AuthorizationUsed(authorizer = a vault), counted per log, never per tx.
 * Returns the AuthorizationUsed log indexes in the receipt whose authorizer is in `isVault`, in log order.
 */
export function vaultSettlementsInReceipt(
  logs: readonly ReceiptLog[],
  token: Address,
  isVault: (a: Address) => boolean,
): number[] {
  return logs
    .filter((l) => same(l.address, token) && l.topics[0] === AUTHORIZATION_USED_TOPIC)
    .filter((l) => isVault(topicAddress(l.topics[1])!))
    .map((l) => l.logIndex)
    .sort((a, b) => a - b);
}

/**
 * R-D2B-6 calls. A call count is reported only where a RecordEntry's counterpartyAuth carries a
 * voucher-set root and the count is derivable from logs. No kind on today's record defines a
 * voucher-set root, and a settlement writes no RecordEntry, so the answer is always "not determinable",
 * with the reason.
 */
export function callsForSettlement(recordEntriesForSubjectInTx: number): { calls: null; callsStatus: string } {
  return {
    calls: null,
    callsStatus:
      recordEntriesForSubjectInTx === 0
        ? "not determinable: no RecordEntry for the account in this settlement's tx carries a voucher-set root"
        : "not determinable: no record kind defines a voucher-set root in counterpartyAuth",
  };
}

// ── Envelope read (R-S184-2) ────────────────────────────────────────

export const ENVELOPE_LABEL = "state read — needs archive RPC";
export const ENVELOPE_CHANGED = "not determinable (envelope changed within block N)";

export type EnvelopeRead = { grantId: Hex; expiry: bigint };

/** Reads at N−1 and N. Equal → that envelope. Different → not determinable, both reads kept. */
export function resolveEnvelope(atPrev: EnvelopeRead, atBlock: EnvelopeRead) {
  const equal = atPrev.grantId.toLowerCase() === atBlock.grantId.toLowerCase() && atPrev.expiry === atBlock.expiry;
  return equal
    ? { envelopeStatus: "determinate" as const, envelopeGrantId: atBlock.grantId, envelopeExpiry: atBlock.expiry }
    : { envelopeStatus: ENVELOPE_CHANGED, envelopeGrantId: null, envelopeExpiry: null };
}

// ── Reproducing commands ────────────────────────────────────────────

/** `cast logs` for exactly this log's block, emitter and topics. Pick the row's log index from the output. */
export function castLogs(block: bigint, address: Address, topics: readonly Hex[]): string {
  return `cast logs --from-block ${block} --to-block ${block} --address ${address} ${topics.join(" ")} --rpc-url "$RPC_URL"`;
}

/** The same query as a raw eth_getLogs body. */
export function ethGetLogs(block: bigint, address: Address, topics: readonly Hex[]): string {
  const b = toHex(block);
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getLogs",
    params: [{ fromBlock: b, toBlock: b, address, topics }],
  });
}

export const ENVELOPE_OF_SIG = "envelopeOf(address,bytes32,address)(bytes32,uint64)";

/** `cast call --block N` for envelopeOf. Needs an archive RPC. */
export function castEnvelopeOf(block: bigint, mandate: Address, account: Address, key: Hex, token: Address): string {
  return `cast call --block ${block} ${mandate} "${ENVELOPE_OF_SIG}" ${account} ${key} ${token} --rpc-url "$ARCHIVE_RPC_URL"`;
}

export const rowId = (chainId: number, txHash: Hex, logIndex: number) => `${chainId}-${txHash}-${logIndex}`;
