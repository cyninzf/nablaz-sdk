// Vault signer adapter for the official x402 EVM client (R-S184-4). The payer is the grantee vault; the
// grantee's key signs, and the signature handed to the token is the vault's ERC-1271 bytes.
//
// Matches GranteeVaultV2.sol at nablaz-protocol 4a38c373:
//   - NAME "NablaZGranteeVault", VERSION "2" (L76-77);
//   - the grantee signs granteeDigest(tokenDomain, structHash) (L129-144): the ERC-7739 TypedDataSign
//     nesting of the TransferWithAuthorization under the vault's domain, hashed under the TOKEN's domain;
//   - the ERC-1271 bytes are abi.encode(Authorization{grantId, token, to, value, validAfter, validBefore,
//     nonce, granteeSignature}) (L96-105), decoded at L151.
//
// The grantee is an EOA or a NablaAccount (s3 §11.15 #10 at nablaz-protocol d6aaba99). The caller says which
// (`Grantee.kind`); the adapter does not guess from code at the address, because an EOA with an EIP-7702
// delegation has code too (s3 §11.15 #2).
//   - EOA: the key signs the TypedDataSign typed data above; the vault's SignatureChecker recovers it.
//   - NablaAccount A: the vault calls A.isValidSignature(granteeDigest, sig). A's controller signs
//     PersonalSign(bytes prefixed) under A's domain {NablaAccount, 3, chainId, A}, with prefixed = the 66-byte
//     EIP-712 preimage of granteeDigest, so keccak256(prefixed) = granteeDigest (AccountSignatures.sol
//     L47-51). Wrapping the digest in A's own TypedDataSign instead would need two EIP-712 types both named
//     TypedDataSign; no typed-data signer can express that, and the adapter never builds it.
//
// R-S186-1 (the restrictive reading of R-B0-1): validBefore = min(envelope expiry, now + the seller's
// maxTimeoutSeconds). The adapter refuses any larger value, so a payload it signs never outlives the envelope
// and never outlives the seller's window. The grantee's key (or A's controller) may be any external signer (a
// viem LocalAccount, a KMS or hardware wallet behind `toAccount`): only `address` and `signTypedData` are used.
//
// The vault is never assumed: at construction the adapter requires vault = predictVault(vaultImpl,
// account, granteeKey) and refuses a vaultImpl that is never a payment target (R-S184-5). vaultImpl must be
// the account's own VAULT_IMPL; `granteeVaultSignerFromChain` reads it. granteeKey is the grant's own key
// (CAM V4 granteeOf / granteeKeyOf): an agentId grant is not keyed by the grantee address.

import {
  concat,
  encodeAbiParameters,
  domainSeparator,
  getAddress,
  hashStruct,
  isAddressEqual,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
} from "viem";
import type { ClientEvmSigner } from "@x402/evm";
import { assertPaymentTarget, predictVault, readVaultImpl } from "./vault.ts";

export const GRANTEE_VAULT_NAME = "NablaZGranteeVault";
export const GRANTEE_VAULT_VERSION = "2";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/** NablaAccount's EIP-712 domain name and version (NablaAccountV3_1 `EIP712("NablaAccount", "3")`). */
export const NABLA_ACCOUNT_NAME = "NablaAccount";
export const NABLA_ACCOUNT_VERSION = "3";

/** ERC-7739 PersonalSign, as AccountSignatures checks it. */
export const PERSONAL_SIGN_TYPES = [{ name: "prefixed", type: "bytes" }] as const;

export const TYPED_DATA_SIGN_TYPES = [
  { name: "contents", type: "TransferWithAuthorization" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
] as const;

const AUTHORIZATION = [
  {
    type: "tuple",
    components: [
      { name: "grantId", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "granteeSignature", type: "bytes" },
    ],
  },
] as const;

export type TransferWithAuthorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

/** What the adapter needs from a key: its address and an EIP-712 signer. */
export type TypedDataSigner = {
  address: Address;
  signTypedData: (args: {
    domain: TypedDataDomain;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: "TypedDataSign" | "PersonalSign";
    message: Record<string, unknown>;
  }) => Promise<Hex>;
};

/** The grant's grantee is an EOA, and this is its key. Signs the TypedDataSign shape. */
export type GranteeKey = TypedDataSigner & { kind?: "eoa" };

/** The grant's grantee is a NablaAccount; its controller signs the PersonalSign shape (s3 §11.15 #10). */
export type AccountGrantee = {
  kind: "account";
  /** The grantee NablaAccount: the grant's grantee wallet. */
  address: Address;
  /** The account's controller key. */
  controller: TypedDataSigner;
};

/** The grant's grantee. `kind` is explicit: "account" for a NablaAccount, else an EOA. */
export type Grantee = GranteeKey | AccountGrantee;

export type GranteeVaultSignerConfig = {
  grantee: Grantee;
  /** The NablaZ account the grant is on. */
  account: Address;
  /** The account's own VAULT_IMPL (never the address table). */
  vaultImpl: Address;
  /** The grant's grantee key (CAM V4 granteeOf); for an agentId grant it is not keyed by the grantee address. */
  granteeKey: Hex;
  /** Must equal predictVault(vaultImpl, account, granteeKey); checked at construction. */
  vault: Address;
  grantId: Hex;
  token: Address;
  chainId: number;
  /** The envelope expiry (CAM V4 envelopeOf). No authorization signed has a later validBefore. */
  expiry: bigint;
  /** The seller's maxTimeoutSeconds for the payment being signed. No validBefore later than now + this. */
  maxTimeoutSeconds: number;
  /** Unix seconds; defaults to the wall clock, the clock the official exact scheme reads. */
  now?: () => number;
};

/** R-S186-1: the latest validBefore the adapter signs, min(envelope expiry, now + seller maxTimeoutSeconds). */
export function maxValidBefore(expiry: bigint, maxTimeoutSeconds: number, now: number): bigint {
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) throw new Error(`maxTimeoutSeconds ${maxTimeoutSeconds} is not a positive integer`);
  const window = BigInt(now) + BigInt(maxTimeoutSeconds);
  return window < expiry ? window : expiry;
}

/** Thrown when asked to sign a validBefore above min(envelope expiry, now + seller maxTimeoutSeconds). */
export class ValidBeforeExceeded extends Error {
  readonly got: bigint;
  readonly max: bigint;
  constructor(got: bigint, max: bigint) {
    super(`validBefore ${got} is above ${max} = min(envelope expiry, now + seller maxTimeoutSeconds)`);
    this.got = got;
    this.max = max;
  }
}

/** Thrown when the configured vault is not predictVault(vaultImpl, account, granteeKey). */
export class VaultMismatch extends Error {
  readonly got: Address;
  readonly expected: Address;
  constructor(got: Address, expected: Address) {
    super(`vault ${got} is not ${expected} = predictVault(vaultImpl, account, granteeKey)`);
    this.got = got;
    this.expected = expected;
  }
}

/** The typed data the grantee signs: GranteeVaultV2.granteeDigest(tokenDomain, structHash). */
export function granteeTypedData(tokenDomain: TypedDataDomain, vault: Address, chainId: number, m: TransferWithAuthorization) {
  return {
    domain: tokenDomain,
    types: { TypedDataSign: TYPED_DATA_SIGN_TYPES, TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES },
    primaryType: "TypedDataSign" as const,
    message: {
      contents: m,
      name: GRANTEE_VAULT_NAME,
      version: GRANTEE_VAULT_VERSION,
      chainId: BigInt(chainId),
      verifyingContract: vault,
      salt: zeroHash,
    },
  };
}

/**
 * What a NablaAccount grantee's controller signs: PersonalSign under the account's domain, over the EIP-712
 * preimage of the vault's grantee digest (0x1901 ‖ token domain separator ‖ TypedDataSign struct hash).
 * The account's PersonalSign check hashes the same thing from the digest alone (AccountSignatures L47-51).
 */
export function accountGranteeTypedData(grantee: Address, chainId: number, vaultTypedData: ReturnType<typeof granteeTypedData>) {
  const { domain, types, message } = vaultTypedData;
  const prefixed = concat(["0x1901", domainSeparator({ domain }), hashStruct({ data: message, primaryType: "TypedDataSign", types })]);
  return {
    domain: { name: NABLA_ACCOUNT_NAME, version: NABLA_ACCOUNT_VERSION, chainId: BigInt(chainId), verifyingContract: getAddress(grantee) },
    types: { PersonalSign: PERSONAL_SIGN_TYPES },
    primaryType: "PersonalSign" as const,
    message: { prefixed },
  };
}

/** The grantee signature for one authorization, in the shape the grantee's kind requires. */
export async function signAsGrantee(grantee: Grantee, vaultTypedData: ReturnType<typeof granteeTypedData>, chainId: number): Promise<Hex> {
  if (grantee.kind === "account") return grantee.controller.signTypedData(accountGranteeTypedData(grantee.address, chainId, vaultTypedData));
  if (grantee.kind !== undefined && grantee.kind !== "eoa") throw new Error(`grantee kind ${String(grantee.kind)} is neither "eoa" nor "account"`);
  return grantee.signTypedData(vaultTypedData);
}

/** The vault's ERC-1271 signature bytes for one authorization. */
export function encodeVaultSignature(grantId: Hex, token: Address, m: TransferWithAuthorization, granteeSignature: Hex): Hex {
  return encodeAbiParameters(AUTHORIZATION, [
    {
      grantId,
      token,
      to: m.to,
      value: m.value,
      validAfter: m.validAfter,
      validBefore: m.validBefore,
      nonce: m.nonce,
      granteeSignature,
    },
  ]);
}

/**
 * A ClientEvmSigner whose address is the vault. Signs EIP-3009 TransferWithAuthorization from the vault only,
 * for one seller window: build one per payment requirement.
 */
export function granteeVaultSigner(cfg: GranteeVaultSignerConfig): ClientEvmSigner {
  const vault = getAddress(cfg.vault);
  const expected = getAddress(predictVault(assertPaymentTarget(cfg.vaultImpl, cfg.account), getAddress(cfg.account), cfg.granteeKey));
  if (vault !== expected) throw new VaultMismatch(vault, expected);
  const token = getAddress(cfg.token);
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  maxValidBefore(cfg.expiry, cfg.maxTimeoutSeconds, 0); // refuse a bad window at construction
  return {
    address: vault,
    async signTypedData({ domain, primaryType, message }) {
      if (primaryType !== "TransferWithAuthorization") throw new Error(`vault signs TransferWithAuthorization only, not ${primaryType}`);
      const d = domain as TypedDataDomain;
      if (!d.verifyingContract || !isAddressEqual(d.verifyingContract, token)) {
        throw new Error(`token ${String(d.verifyingContract)} is not the envelope token ${token}`);
      }
      if (Number(d.chainId) !== cfg.chainId) throw new Error(`chainId ${String(d.chainId)} is not ${cfg.chainId}`);
      const raw = message as Record<string, string | bigint>;
      const m: TransferWithAuthorization = {
        from: getAddress(String(raw.from)),
        to: getAddress(String(raw.to)),
        value: BigInt(raw.value!),
        validAfter: BigInt(raw.validAfter!),
        validBefore: BigInt(raw.validBefore!),
        nonce: raw.nonce as Hex,
      };
      if (!isAddressEqual(m.from, vault)) throw new Error(`from ${m.from} is not the vault ${vault}`);
      const max = maxValidBefore(cfg.expiry, cfg.maxTimeoutSeconds, now());
      if (m.validBefore > max) throw new ValidBeforeExceeded(m.validBefore, max);
      if (!/^0x[0-9a-fA-F]{64}$/.test(m.nonce)) throw new Error("nonce is not 32 bytes");
      const granteeSignature = await signAsGrantee(cfg.grantee, granteeTypedData(d, vault, cfg.chainId, m), cfg.chainId);
      return encodeVaultSignature(cfg.grantId, token, m, granteeSignature);
    },
  };
}

/** granteeVaultSigner with vaultImpl read from the account's own VAULT_IMPL (readVaultImpl). */
export async function granteeVaultSignerFromChain(
  client: PublicClient,
  cfg: Omit<GranteeVaultSignerConfig, "vaultImpl">,
  blockNumber?: bigint,
): Promise<ClientEvmSigner> {
  return granteeVaultSigner({ ...cfg, vaultImpl: await readVaultImpl(client, getAddress(cfg.account), blockNumber) });
}
