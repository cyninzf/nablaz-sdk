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
// R-S186-1 (the restrictive reading of R-B0-1): validBefore = min(envelope expiry, now + the seller's
// maxTimeoutSeconds). The adapter refuses any larger value, so a payload it signs never outlives the envelope
// and never outlives the seller's window. The grantee may be any external signer (a viem LocalAccount, a KMS
// or hardware wallet behind `toAccount`): only `address` and `signTypedData` are used.

import { encodeAbiParameters, getAddress, isAddressEqual, zeroHash, type Address, type Hex, type TypedDataDomain } from "viem";
import type { ClientEvmSigner } from "@x402/evm";

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

/** What the adapter needs from the grantee's key. */
export type GranteeKey = {
  address: Address;
  signTypedData: (args: {
    domain: TypedDataDomain;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: "TypedDataSign";
    message: Record<string, unknown>;
  }) => Promise<Hex>;
};

export type GranteeVaultSignerConfig = {
  grantee: GranteeKey;
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
      const granteeSignature = await cfg.grantee.signTypedData(granteeTypedData(d, vault, cfg.chainId, m));
      return encodeVaultSignature(cfg.grantId, token, m, granteeSignature);
    },
  };
}
