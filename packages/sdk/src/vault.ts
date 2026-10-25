// Grantee key and grantee-vault address. The vault implementation is always read from the account
// (NablaAccountV3_1.VAULT_IMPL()), never taken from the address table: an account's vaults are clones of
// whatever implementation the account was built with, and a v1 vault is never a payment target (R-S184-5).

import {
  concat,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { NEVER_PAYMENT_TARGET } from "./generated/addresses.ts";

/** CAM V4 granteeKeyOf: agentId grants key by agentId, address grants by the grantee. Pure. */
export function granteeKeyOf(grantee: Address, agentId: bigint): Hex {
  return agentId !== 0n
    ? keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [1, agentId]))
    : keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [0, grantee]));
}

/**
 * The init code of an EIP-1167 clone of `impl` with immutable args `args` (OpenZeppelin Clones,
 * cloneDeterministicWithImmutableArgs).
 */
export function cloneInitCode(impl: Address, args: Hex): Hex {
  const argsLen = (args.length - 2) / 2;
  return concat([
    "0x61",
    numberToHex(argsLen + 0x2d, { size: 2 }),
    "0x3d81600a3d39f3363d3d373d3d3d363d73",
    impl,
    "0x5af43d82803e903d91602b57fd5bf3",
    args,
  ]);
}

/**
 * AccountVaults.vaultOf: the vault `account` deploys for `granteeKey` — a clone of `vaultImpl` with
 * immutable args `(account, granteeKey)`, salt `granteeKey`, deployer `account`. Pure; the caller must pass
 * the account's own VAULT_IMPL (see `vaultOf`).
 */
export function predictVault(vaultImpl: Address, account: Address, granteeKey: Hex): Address {
  const args = encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [account, granteeKey]);
  return getContractAddress({ opcode: "CREATE2", from: account, salt: granteeKey, bytecode: cloneInitCode(vaultImpl, args) });
}

const accountAbi = parseAbi(["function VAULT_IMPL() view returns (address)"]);

/** Thrown for a vault implementation listed in NEVER_PAYMENT_TARGET (R-S184-5). */
export class NeverPaymentTarget extends Error {
  readonly impl: Address;
  constructor(impl: Address, account?: Address) {
    super(`${account ? `account ${account} uses ` : ""}vault implementation ${impl}, which is never a payment target`);
    this.impl = impl;
  }
}

/** Refuses an implementation listed in NEVER_PAYMENT_TARGET. Returns it checksummed. */
export function assertPaymentTarget(vaultImpl: Address, account?: Address): Address {
  const impl = getAddress(vaultImpl);
  if (NEVER_PAYMENT_TARGET.some((a) => a.toLowerCase() === impl.toLowerCase())) throw new NeverPaymentTarget(impl, account);
  return impl;
}

/** The account's vault implementation. Refuses an implementation that is never a payment target. */
export async function readVaultImpl(client: PublicClient, account: Address, blockNumber?: bigint): Promise<Address> {
  return assertPaymentTarget(
    await client.readContract({ address: account, abi: accountAbi, functionName: "VAULT_IMPL", blockNumber }),
    account,
  );
}

/** The grantee vault for `granteeKey` on `account`, predicted from the account's own VAULT_IMPL. */
export async function vaultOf(client: PublicClient, account: Address, granteeKey: Hex, blockNumber?: bigint) {
  return predictVault(await readVaultImpl(client, account, blockNumber), account, granteeKey);
}
