// s3 §11.15 #10 on an anvil fork of Arbitrum One at FORK_BLOCK, against the live permanent stack: a grant on
// the TEST account whose grantee is a NablaAccount A, created on the live factory with a fork-only controller
// key. The SDK builds A's grantee signature as PersonalSign under A's domain; the live vault answers the
// ERC-1271 magic value, and the official x402 client, seller and facilitator settle a payment with it. The
// EOA (TypedDataSign) shape signed by A's controller is refused. TypedDataSign nested in A's own
// TypedDataSign cannot be built by an EIP-712 signer and the SDK never builds it; signed as a raw hash, the
// live bytecode accepts it, and the last case records that answer. No mainnet transaction.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hashStruct,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  publicActions,
  size,
  stringToHex,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { ConsumerAIMandateV4Abi, GranteeVaultV2Abi, NablaAccountFactoryPermanentAbi, NablaAccountV3_1Abi, NablaRecordAbi } from "../../src/generated/abis.ts";
import {
  ARBITRUM_ONE,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  accountGranteeTypedData,
  granteeKeyOf,
  granteeTypedData,
  granteeVaultSigner,
  payInsideGrant,
  type AccountGrantee,
} from "../../src/index.ts";
import { startSeller, type Seller } from "../../tools/seller.ts";
import { FORK_BLOCK, startAnvil, type Anvil } from "./anvil.ts";

const C = ARBITRUM_ONE.contracts;
const NETWORK = "eip155:42161" as const;
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TEST: Address = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
const HOLDER: Address = "0x8A6cec15736F3072Db75514815F7470f64dF0100";
const PAY_TO: Address = "0x1633647e98534880807A4ea19862b9bb47a00645";
const FACILITATOR: Address = "0x00000000000000000000000000000000000fac01";
const USDC_WHALE: Address = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MAGIC = "0x1626ba7e";
const INVALID = "0xffffffff";
const PAY_ACTION_KEY = keccak256(concat([USDC, toFunctionSelector("transfer(address,uint256)")]));
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: USDC } as const;

const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);
const AUTHORIZATION = [
  { type: "tuple", components: [{ name: "grantId", type: "bytes32" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "granteeSignature", type: "bytes" }] },
] as const;

// The account grantee's controller: a fork-only key with no code (s3 §11.15 #2: the anvil dev keys carry an
// EIP-7702 delegation on Arbitrum One).
const controller = privateKeyToAccount(keccak256(stringToHex("nablaz fork-only account-grantee controller")));

let anvil: Anvil;
let pub: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let seller: Seller;
const S = {} as { A: Address; key: Hex; grantId: Hex; vault: Address; start: bigint; expiry: bigint };
const report: Record<string, unknown> = { forkBlock: FORK_BLOCK, controller: controller.address };
const calls: { op: "verify" | "settle"; result: VerifyResponse | SettleResponse }[] = [];

const exec = async (from: Address, to: Address, data: Hex) => {
  const hash = await wallet.sendTransaction({ account: from, to, data, chain: arbitrum });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
};
const usdc = (a: Address) => pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [a] });
const vaultAnswer = (hash: Hex, signature: Hex) => pub.readContract({ address: S.vault, abi: GranteeVaultV2Abi, functionName: "isValidSignature", args: [hash, signature] });

/** One authorization from the vault, its USDC digest, and the vault's ERC-1271 bytes around `granteeSignature`. */
async function authorization(granteeSignature: (vaultTd: ReturnType<typeof granteeTypedData>) => Promise<Hex>, nonce: Hex) {
  const { timestamp } = await pub.getBlock();
  const m = { from: S.vault, to: PAY_TO, value: 10_000n, validAfter: 0n, validBefore: timestamp + 300n, nonce };
  const usdcDigest = hashTypedData({ domain: USDC_DOMAIN, types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES }, primaryType: "TransferWithAuthorization", message: m });
  const sig = await granteeSignature(granteeTypedData(USDC_DOMAIN, S.vault, 42161, m));
  const bytes = encodeAbiParameters(AUTHORIZATION, [{ grantId: S.grantId, token: USDC, ...m, granteeSignature: sig }]);
  return { m, usdcDigest, bytes };
}

function localFacilitator(): FacilitatorClient {
  const client = createWalletClient({ account: FACILITATOR, chain: arbitrum, transport: http(anvil.url) }).extend(publicActions);
  const signer = toFacilitatorEvmSigner({
    address: FACILITATOR,
    readContract: (a) => client.readContract(a as never),
    verifyTypedData: (a) => client.verifyTypedData(a as never),
    writeContract: (a) => client.writeContract({ ...(a as object), account: FACILITATOR, chain: arbitrum } as never),
    sendTransaction: (a) => client.sendTransaction({ ...a, account: FACILITATOR, chain: arbitrum }),
    waitForTransactionReceipt: (a) => client.waitForTransactionReceipt(a),
    getCode: (a) => client.getCode(a),
  });
  const f = new x402Facilitator().register(NETWORK, new ExactEvmFacilitatorScheme(signer));
  return {
    verify: async (p: PaymentPayload, r: PaymentRequirements) => {
      const result = await f.verify(p, r);
      calls.push({ op: "verify", result });
      return result;
    },
    settle: async (p: PaymentPayload, r: PaymentRequirements) => {
      const result = await f.settle(p, r);
      calls.push({ op: "settle", result });
      return result;
    },
    getSupported: async () => f.getSupported() as never,
  };
}

beforeAll(async () => {
  anvil = await startAnvil(FORK_BLOCK);
  const transport = http(anvil.url);
  pub = createPublicClient({ chain: arbitrum, transport }) as PublicClient;
  const test = createTestClient({ chain: arbitrum, mode: "anvil", transport });
  wallet = createWalletClient({ chain: arbitrum, transport });
  for (const a of [HOLDER, FACILITATOR, USDC_WHALE]) {
    await test.impersonateAccount({ address: a });
    await test.setBalance({ address: a, value: 10n ** 21n });
  }
  await test.setBalance({ address: controller.address, value: 10n ** 21n });
  S.start = (await pub.getBlock()).timestamp;
  S.expiry = S.start + 7n * 86_400n;
  seller = await startSeller({ facilitator: localFacilitator(), network: NETWORK, routes: [{ path: "/paid", payTo: PAY_TO, price: "$0.01" }] });
}, 120_000);

afterAll(async () => {
  console.log(JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  await seller?.close();
  await anvil?.stop();
});

describe("s3 §11.15 #10: a NablaAccount grantee signs PersonalSign", () => {
  it("setup: A on the live factory (controller = fork-only key), TEST grants A, TEST reserves into A's vault", async () => {
    expect(await pub.getCode({ address: controller.address })).toBeUndefined();
    const created = await pub.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({
        account: controller,
        chain: arbitrum,
        to: C.NablaAccountFactoryPermanent.address,
        data: encodeFunctionData({ abi: NablaAccountFactoryPermanentAbi, functionName: "createAccount", args: [[]] }),
      }),
    });
    expect(created.status).toBe("success");
    S.A = await pub.readContract({ address: C.NablaAccountFactoryPermanent.address, abi: NablaAccountFactoryPermanentAbi, functionName: "predictAddress", args: [controller.address] });
    const impl = await pub.getStorageAt({ address: S.A, slot: IMPL_SLOT });
    const domain = await pub.readContract({ address: S.A, abi: NablaAccountV3_1Abi, functionName: "eip712Domain" });
    expect(getAddress(`0x${impl!.slice(-40)}`)).toBe(C.NablaAccountV3_1.address);
    expect(await pub.readContract({ address: S.A, abi: NablaAccountV3_1Abi, functionName: "controller" })).toBe(controller.address);
    expect([domain[1], domain[2], domain[3], domain[4]]).toEqual(["NablaAccount", "3", 42161n, S.A]);

    S.key = granteeKeyOf(S.A, 0n);
    const spec = {
      grantee: S.A,
      agentId: 0n,
      expiry: S.expiry,
      allowances: [{ tokenAddress: USDC, periodAmount: 1_000_000n, periodDuration: 0, startTime: S.start, perTx: 100_000n, secondWindow: { periodAmount: 0n, periodDuration: 0 } }],
      counterparties: [PAY_TO],
      scope: [PAY_ACTION_KEY],
      descriptors: [],
    } as const;
    const g = await exec(HOLDER, TEST, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "grant", args: [spec] }));
    S.grantId = parseEventLogs({ abi: NablaRecordAbi, eventName: "RecordEntry", logs: g.logs })[0]!.args.writerAuth;
    expect(await pub.readContract({ address: C.ConsumerAIMandateV4.address, abi: ConsumerAIMandateV4Abi, functionName: "granteeOf", args: [TEST, S.grantId] })).toEqual([S.A, S.key]);

    await exec(USDC_WHALE, USDC, encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [TEST, 1_000_000n] }));
    const { result } = await pub.simulateContract({ address: TEST, abi: NablaAccountV3_1Abi, functionName: "reservePayment", args: [S.grantId, USDC, 1_000_000n, S.expiry], account: HOLDER });
    await exec(HOLDER, TEST, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "reservePayment", args: [S.grantId, USDC, 1_000_000n, S.expiry] }));
    S.vault = result[0];
    expect(await usdc(S.vault)).toBe(1_000_000n);
    report.setup = { account: S.A, createTx: created.transactionHash, grantTx: g.transactionHash, grantId: S.grantId, granteeKey: S.key, vault: S.vault };
  });

  it("the SDK's PersonalSign shape: the live vault answers the ERC-1271 magic value", async () => {
    const grantee: AccountGrantee = { kind: "account", address: S.A, controller };
    const { timestamp } = await pub.getBlock();
    const signer = granteeVaultSigner({ grantee, account: TEST, vaultImpl: C.GranteeVaultV2.address, granteeKey: S.key, vault: S.vault, grantId: S.grantId, token: USDC, chainId: 42161, expiry: S.expiry, maxTimeoutSeconds: 300, now: () => Number(timestamp) });
    const m = { from: S.vault, to: PAY_TO, value: 10_000n, validAfter: 0n, validBefore: timestamp + 300n, nonce: keccak256(stringToHex("personal-sign 1")) };
    const bytes = await signer.signTypedData({ domain: USDC_DOMAIN, types: {}, primaryType: "TransferWithAuthorization", message: m });
    const usdcDigest = hashTypedData({ domain: USDC_DOMAIN, types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES }, primaryType: "TransferWithAuthorization", message: m });
    const answer = await vaultAnswer(usdcDigest, bytes);
    // The same answer as A's own check over the vault digest.
    const vaultDigest = hashTypedData(granteeTypedData(USDC_DOMAIN, S.vault, 42161, m));
    const sig = await controller.signTypedData(accountGranteeTypedData(S.A, 42161, granteeTypedData(USDC_DOMAIN, S.vault, 42161, m)));
    const accountAnswer = await pub.readContract({ address: S.A, abi: NablaAccountV3_1Abi, functionName: "isValidSignature", args: [vaultDigest, sig] });
    report.personalSign = { block: (await pub.getBlockNumber()).toString(), vaultIsValidSignature: answer, accountIsValidSignature: accountAnswer, signatureBytes: size(bytes) };
    expect(answer).toBe(MAGIC);
    expect(accountAnswer).toBe(MAGIC);
  });

  it("payInsideGrant with the account grantee: official client, seller and facilitator settle from the vault", async () => {
    const p = await payInsideGrant({ publicClient: pub, account: TEST, grantId: S.grantId, token: USDC, grantee: { kind: "account", address: S.A, controller } });
    expect(p.vault).toBe(S.vault);
    const before = { payTo: await usdc(PAY_TO), vault: await usdc(S.vault) };
    const n = calls.length;
    const res = await p.fetch(`${seller.url}/paid`);
    const mine = calls.slice(n);
    const settle = mine.find((c) => c.op === "settle")?.result as SettleResponse | undefined;
    report.settlement = { httpStatus: res.status, ops: mine.map((c) => c.op), verify: mine[0]?.result, settleTx: settle?.transaction, before, after: { payTo: await usdc(PAY_TO), vault: await usdc(S.vault) } };
    expect(res.status).toBe(200);
    expect(mine.map((c) => c.op)).toEqual(["verify", "settle"]);
    expect((mine[0]!.result as VerifyResponse).isValid).toBe(true);
    expect(settle!.success).toBe(true);
    expect(await usdc(PAY_TO)).toBe(before.payTo + 10_000n);
    expect(await usdc(S.vault)).toBe(before.vault - 10_000n);
  });

  it("refused: the EOA (TypedDataSign) shape signed by A's controller", async () => {
    const { usdcDigest, bytes } = await authorization((td) => controller.signTypedData(td), keccak256(stringToHex("typed-data-sign")));
    const answer = await vaultAnswer(usdcDigest, bytes);
    report.refusedTypedDataSign = answer;
    expect(answer).toBe(INVALID);
  });

  it("TypedDataSign nested in A's own TypedDataSign, signed as a raw hash: the live bytecode answers MAGIC", async () => {
    // No EIP-712 signer can produce this: the outer and inner types are both named TypedDataSign. The SDK
    // never builds it (test/unit/account-grantee.test.ts). Built here by hand with a raw-hash signature, to
    // record what the chain does with it: AccountSignatures._nestedTypedData does not refuse a contents type
    // named TypedDataSign, so only the controller's key stands between this shape and the magic value.
    const contentsDescr =
      "TypedDataSign(TransferWithAuthorization contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
    const { usdcDigest, bytes } = await authorization(async (td) => {
      const tokenDomain = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
          [keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(stringToHex("USD Coin")), keccak256(stringToHex("2")), 42161n, USDC],
        ),
      );
      // contentsHash = the vault's TypedDataSign struct hash, so toTypedDataHash(tokenDomain, contentsHash) = granteeDigest.
      const inner = hashStruct({ data: td.message, primaryType: "TypedDataSign", types: td.types });
      expect(keccak256(concat(["0x1901", tokenDomain, inner]))).toBe(hashTypedData(td));
      const typehash = keccak256(stringToHex(`TypedDataSign(TypedDataSign contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)${contentsDescr}`));
      const accountDomainFields = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }],
        [keccak256(stringToHex("NablaAccount")), keccak256(stringToHex("3")), 42161n, S.A, `0x${"00".repeat(32)}`],
      );
      const outer = keccak256(concat([typehash, inner, accountDomainFields]));
      const raw = await controller.sign({ hash: keccak256(concat(["0x1901", tokenDomain, outer])) });
      return encodePacked(["bytes", "bytes32", "bytes32", "string", "uint16"], [raw, tokenDomain, inner, contentsDescr, size(toHex(contentsDescr))]);
    }, keccak256(stringToHex("nested")));
    const answer = await vaultAnswer(usdcDigest, bytes);
    report.nestedTypedDataSignRawHash = answer;
    expect(answer).toBe(MAGIC);
  });

  it("payInsideGrant refuses a NablaAccount grantee passed as an EOA, and a controller that is not A's", async () => {
    await expect(payInsideGrant({ publicClient: pub, account: TEST, grantId: S.grantId, token: USDC, grantee: { ...controller, address: S.A } })).rejects.toThrow(/has contract code; a NablaAccount grantee is passed with kind: "account"/);
    const other = privateKeyToAccount(keccak256(stringToHex("not the controller")));
    await expect(payInsideGrant({ publicClient: pub, account: TEST, grantId: S.grantId, token: USDC, grantee: { kind: "account", address: S.A, controller: other } })).rejects.toThrow(/controller is/);
  });
});
