// s3 §11.15 #10 at nablaz-protocol d6aaba99: when the grantee is a NablaAccount A, A's controller signs
// PersonalSign(bytes prefixed) over the vault's grantee digest under A's domain; an EOA grantee keeps the
// TypedDataSign shape. The on-chain proof is test/fork/account-grantee.fork.test.ts.

import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, hashTypedData, keccak256, recoverAddress, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountGranteeTypedData, granteeTypedData, granteeVaultSigner, signAsGrantee, type Grantee, type TypedDataSigner } from "../../src/index";

const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TEST: Address = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
const VAULT_IMPL: Address = "0x630963b04c992d912F26e9bEF8C9339b2c29aED0";
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: USDC } as const;
const A: Address = "0x00000000000000000000000000000000000a0001";
const M = {
  from: "0x46414CFb3F27735F2a9824abfb63699bF80ed001" as Address,
  to: "0x1633647e98534880807A4ea19862b9bb47a00645" as Address,
  value: 10_000n,
  validAfter: 0n,
  validBefore: 1_793_491_200n,
  nonce: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
};
// GranteeVaultV2(impl).granteeDigest(USDC.DOMAIN_SEPARATOR(), structHash(M)), by eth_call on Arbitrum One at
// block 517955000 (the same known answer as test/unit/vault.test.ts).
const LIVE_DIGEST: Hex = "0x6ea7d6a702fd2d31cb9f4677c6065973cf2ac8729f87eba45abe92622f1aeaef";

const controller = privateKeyToAccount(keccak256(stringToHex("nablaz unit account-grantee controller")));

/** AccountSignatures._nestedPersonal's hash, rebuilt from the contract's own constants (L19-27, L47-51). */
function accountPersonalHash(account: Address, chainId: bigint, hash: Hex): Hex {
  const domainSep = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(stringToHex("NablaAccount")),
        keccak256(stringToHex("3")),
        chainId,
        account,
      ],
    ),
  );
  const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keccak256(stringToHex("PersonalSign(bytes prefixed)")), hash]));
  return keccak256(`0x1901${domainSep.slice(2)}${structHash.slice(2)}`);
}

describe("account grantee: PersonalSign shape", () => {
  const vaultTd = granteeTypedData(USDC_DOMAIN, VAULT_IMPL, 42161, M);

  it("prefixed is the EIP-712 preimage of the vault's grantee digest (live known answer)", () => {
    const td = accountGranteeTypedData(A, 42161, vaultTd);
    expect(hashTypedData(vaultTd)).toBe(LIVE_DIGEST);
    expect((td.message.prefixed.length - 2) / 2).toBe(66);
    expect(keccak256(td.message.prefixed)).toBe(LIVE_DIGEST);
    expect(td.domain).toEqual({ name: "NablaAccount", version: "3", chainId: 42161n, verifyingContract: A });
    expect(td.primaryType).toBe("PersonalSign");
  });

  it("what the controller signs is the hash AccountSignatures checks, and it recovers to the controller", async () => {
    const td = accountGranteeTypedData(A, 42161, vaultTd);
    expect(hashTypedData(td)).toBe(accountPersonalHash(A, 42161n, LIVE_DIGEST));
    const sig = await signAsGrantee({ kind: "account", address: A, controller }, vaultTd, 42161);
    expect(await recoverAddress({ hash: accountPersonalHash(A, 42161n, LIVE_DIGEST), signature: sig })).toBe(controller.address);
  });

  it("the signer asks an account grantee's controller for PersonalSign only, never TypedDataSign", async () => {
    const signTypedData = vi.fn((a: Parameters<TypedDataSigner["signTypedData"]>[0]) => controller.signTypedData(a as never));
    const vault = "0x46414CFb3F27735F2a9824abfb63699bF80ed001" as Address;
    const signer = granteeVaultSigner({
      grantee: { kind: "account", address: A, controller: { address: controller.address, signTypedData } },
      account: TEST,
      vaultImpl: VAULT_IMPL,
      granteeKey: "0x2c2ed5dd86fb43ad5766dcfa4e33aaf46c79270badcd0d3a429c08741b69c8fa",
      vault,
      grantId: `0x${"22".repeat(32)}`,
      token: USDC,
      chainId: 42161,
      expiry: 1_793_491_200n,
      maxTimeoutSeconds: 300,
      now: () => 1_793_000_000,
    });
    const m = { ...M, validBefore: 1_793_000_100n };
    const bytes = await signer.signTypedData({ domain: USDC_DOMAIN, types: {}, primaryType: "TransferWithAuthorization", message: m });
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData.mock.calls[0]![0].primaryType).toBe("PersonalSign");
    const [auth] = decodeAbiParameters([{ type: "tuple", components: [{ name: "grantId", type: "bytes32" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "granteeSignature", type: "bytes" }] }], bytes);
    const digest = hashTypedData(granteeTypedData(USDC_DOMAIN, vault, 42161, m));
    expect(await recoverAddress({ hash: accountPersonalHash(A, 42161n, digest), signature: auth.granteeSignature })).toBe(controller.address);
  });

  it("an EOA grantee (kind omitted or \"eoa\") keeps the TypedDataSign shape", async () => {
    for (const g of [controller, { ...controller, kind: "eoa" as const }] as Grantee[]) {
      const sig = await signAsGrantee(g, vaultTd, 42161);
      expect(await recoverAddress({ hash: LIVE_DIGEST, signature: sig })).toBe(controller.address);
    }
  });

  it("refuses a grantee kind it does not know, rather than guessing a shape", async () => {
    await expect(signAsGrantee({ ...controller, kind: "contract" } as unknown as Grantee, vaultTd, 42161)).rejects.toThrow(/neither "eoa" nor "account"/);
  });
});
