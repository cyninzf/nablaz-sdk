import { describe, expect, it } from "vitest";
import { decodeAbiParameters, hashTypedData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARBITRUM_ONE,
  NEVER_PAYMENT_TARGET,
  envelopeExactScheme,
  granteeKeyOf,
  granteeTypedData,
  granteeVaultSigner,
  predictVault,
  ValidBeforeMismatch,
} from "../../src/index";

const C = ARBITRUM_ONE.contracts;
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TEST: Address = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
const PAY_TO: Address = "0x1633647e98534880807A4ea19862b9bb47a00645";
const HOT_KEY: Address = "0xCc885831ef9B284E7D5F199A6f4f72D290CC0243";
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: USDC } as const;

// Known answers read from Arbitrum One at block 517955000 by eth_call, i.e. computed by the live
// NablaAccountV3_1 bytecode (granteeVault → AccountVaults.vaultOf(VAULT_IMPL, key)) and the live
// GranteeVaultV2 bytecode (granteeDigest). If the SDK's derivation drifts from the contracts, these fail.
const LIVE = {
  vaultImpl: "0x630963b04c992d912F26e9bEF8C9339b2c29aED0" as Address, // TEST.VAULT_IMPL()
  vaults: [
    { grantee: HOT_KEY, agentId: 0n, key: "0x2c2ed5dd86fb43ad5766dcfa4e33aaf46c79270badcd0d3a429c08741b69c8fa", vault: "0x46414CFb3F27735F2a9824abfb63699bF80ed001" },
    { grantee: "0x0000000000000000000000000000000000000001", agentId: 0n, key: "0xa6eef7e35abe7026729641147f7915573c7e97b47efa546f5f6e3230263bcb49", vault: "0x6Da17E3f2e60E726355eB98F1c956E78F7B3ab20" },
    { grantee: "0x0000000000000000000000000000000000000000", agentId: 7n, key: "0xb39221ace053465ec3453ce2b36430bd138b997ecea25c1043da0c366812b828", vault: "0x9F70b01f87e78556b06627e37D89699692841eBB" },
  ] as const,
  // GranteeVaultV2(impl).granteeDigest(USDC.DOMAIN_SEPARATOR(), structHash(m)) with m below; on the
  // implementation itself address(this) = the implementation.
  digest: "0x6ea7d6a702fd2d31cb9f4677c6065973cf2ac8729f87eba45abe92622f1aeaef" as Hex,
};
const M = {
  from: "0x46414CFb3F27735F2a9824abfb63699bF80ed001" as Address,
  to: PAY_TO,
  value: 10_000n,
  validAfter: 0n,
  validBefore: 1_793_491_200n,
  nonce: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
};

describe("address table (Finding 1)", () => {
  it("lists the live vault and account implementations with their deploy blocks", () => {
    expect(C.GranteeVaultV2).toEqual({ address: "0x630963b04c992d912F26e9bEF8C9339b2c29aED0", deployBlock: 517846272, status: "live" });
    expect(C.NablaAccountV3_1).toEqual({ address: "0x3786B747AEf4E31A7A45cc7EBBBc8C462927AcDc", deployBlock: 517846308, status: "live" });
  });
  it("keeps v1 as coexisting and never a payment target", () => {
    expect(C.GranteeVault.status).toBe("coexisting");
    expect(C.NablaAccountV3.status).toBe("coexisting");
    expect(NEVER_PAYMENT_TARGET).toEqual([C.GranteeVault.address]);
  });
});

describe("vault address = AccountVaults.vaultOf(VAULT_IMPL, granteeKey)", () => {
  for (const v of LIVE.vaults) {
    it(`key ${v.key.slice(0, 10)}…`, () => {
      expect(granteeKeyOf(v.grantee, v.agentId)).toBe(v.key);
      expect(predictVault(LIVE.vaultImpl, TEST, v.key)).toBe(v.vault);
      // The old fixture's mistake: predicting from the v1 implementation gives a different address.
      expect(predictVault(C.GranteeVault.address, TEST, v.key)).not.toBe(v.vault);
    });
  }
});

describe("vault signer adapter", () => {
  const grantee = privateKeyToAccount(keccak256(stringToHex("unit-test grantee")));
  const grantId = keccak256(stringToHex("grant"));
  const vault = M.from;
  const signer = granteeVaultSigner({ grantee, vault, grantId, token: USDC, chainId: 42161, validBefore: M.validBefore });
  const sign = (m: Partial<typeof M>, primaryType = "TransferWithAuthorization", domain: Record<string, unknown> = USDC_DOMAIN) =>
    signer.signTypedData({ domain, types: {}, primaryType, message: { ...M, ...m } });

  it("hashes what GranteeVaultV2.granteeDigest hashes", () => {
    expect(hashTypedData(granteeTypedData(USDC_DOMAIN, LIVE.vaultImpl, 42161, { ...M }))).toBe(LIVE.digest);
  });

  it("returns abi.encode(Authorization) carrying the grantee's signature over the digest", async () => {
    const sig = await sign({});
    const [a] = decodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "grantId", type: "bytes32" }, { name: "token", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }, { name: "granteeSignature", type: "bytes" },
      ] }],
      sig,
    );
    expect(a).toMatchObject({ grantId, token: USDC, to: PAY_TO, value: 10_000n, validAfter: 0n, validBefore: M.validBefore, nonce: M.nonce });
    expect(a.granteeSignature).toBe(await grantee.signTypedData(granteeTypedData(USDC_DOMAIN, vault, 42161, { ...M })));
    expect(signer.address).toBe(vault);
  });

  it("refuses a validBefore other than the envelope expiry (R-B0-1)", async () => {
    await expect(sign({ validBefore: M.validBefore - 1n })).rejects.toBeInstanceOf(ValidBeforeMismatch);
  });
  it("refuses another payer, token, chain or payload type", async () => {
    await expect(sign({ from: PAY_TO })).rejects.toThrow(/not the vault/);
    await expect(sign({}, "TransferWithAuthorization", { ...USDC_DOMAIN, verifyingContract: PAY_TO })).rejects.toThrow(/not the envelope token/);
    await expect(sign({}, "TransferWithAuthorization", { ...USDC_DOMAIN, chainId: 8453 })).rejects.toThrow(/chainId/);
    await expect(sign({}, "Permit")).rejects.toThrow(/TransferWithAuthorization only/);
  });
});

describe("envelope exact scheme (official ExactEvmScheme underneath)", () => {
  const grantee = privateKeyToAccount(keccak256(stringToHex("unit-test grantee")));
  const validBefore = 2_000_000_000n;
  const signer = granteeVaultSigner({ grantee, vault: M.from, grantId: keccak256("0x01"), token: USDC, chainId: 42161, validBefore });
  const req = {
    scheme: "exact",
    network: "eip155:42161" as const,
    asset: USDC,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };

  it("lands validBefore on the envelope expiry with a random 32-byte nonce", async () => {
    const scheme = envelopeExactScheme(signer, validBefore);
    const a = await scheme.createPaymentPayload(2, req);
    const b = await scheme.createPaymentPayload(2, req);
    const auth = (p: typeof a) => (p.payload as { authorization: Record<string, string> }).authorization;
    expect(auth(a).validBefore).toBe(validBefore.toString());
    expect(auth(a).from).toBe(M.from);
    expect(auth(a).nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(auth(a).nonce).not.toBe(auth(b).nonce);
  });
  it("never signs another validBefore, even when its clock and the official scheme's disagree", async () => {
    // The official scheme reads Date.now(); this clock is 100 s off, so every attempt is refused.
    const scheme = envelopeExactScheme(signer, validBefore, () => Math.floor(Date.now() / 1000) + 100);
    await expect(scheme.createPaymentPayload(2, req)).rejects.toBeInstanceOf(ValidBeforeMismatch);
  });
  it("refuses Permit2 and an expired envelope", async () => {
    await expect(envelopeExactScheme(signer, validBefore).createPaymentPayload(2, { ...req, extra: { ...req.extra, assetTransferMethod: "permit2" } })).rejects.toThrow(/out of scope/);
    await expect(envelopeExactScheme(signer, 5n).createPaymentPayload(2, req)).rejects.toThrow(/too late/);
  });
});

