// S186 B2 Phase 0: the whole first-payment path on an anvil fork of Arbitrum One, against the live permanent
// stack and the live TEST account (nothing from nablaz-protocol is deployed locally). The seller, the
// facilitator and the client are the official x402 packages, unpatched; the facilitator runs locally
// against the fork. Steps follow the relay's §4 numbering; every observed value lands in `report`.
//
// Grantee key: B2_GRANTEE_HOT_KEY when set (the key the mainnet run uses), otherwise a fork-only key.

import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  publicActions,
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
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ConsumerAIMandateV4Abi, GranteeVaultV2Abi, NablaAccountV3_1Abi, NablaRecordAbi } from "../../src/generated/abis.ts";
import { ARBITRUM_ONE, granteeKeyOf, granteeTypedData, payInsideGrant, vaultOf, type GrantPayment } from "../../src/index.ts";
import { startSeller, type Seller } from "../../tools/seller.ts";
import { indexOnce } from "../../../reader/test/fork/harness.ts";
import { FORK_BLOCK, startAnvil, type Anvil } from "./anvil.ts";

const C = ARBITRUM_ONE.contracts;
const NETWORK = "eip155:42161" as const;
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TEST: Address = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
const HOLDER: Address = "0x8A6cec15736F3072Db75514815F7470f64dF0100";
const ZK_GATE: Address = "0x207AB6ef123aEA547A68f609C9C3b7AF7AA866Ee"; // checksummed (the relay wrote 0x207Ab6Ef…66eE)
const PAY_TO: Address = "0x1633647e98534880807A4ea19862b9bb47a00645";
const OTHER_PAYEE: Address = "0x00000000000000000000000000000000000e0001";
const FACILITATOR: Address = "0x00000000000000000000000000000000000fac01";
const USDC_WHALE: Address = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
const READER_DIR = new URL("../../../reader/", import.meta.url).pathname;
const SELLER_WINDOW = 300; // tools/seller.ts default maxTimeoutSeconds
const KIND = (n: string) => keccak256(stringToHex(n));
const PAY_ACTION_KEY = keccak256(concat([USDC, toFunctionSelector("transfer(address,uint256)")]));
// ERC-8021 suffix: codes, codesLength, schemaId 0, then the 16-byte marker (read from the end).
const ERC8021_SUFFIX = concat([stringToHex("nablaz-p0"), toHex(9, { size: 1 }), "0x00", "0x80218021802180218021802180218021"]);

const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);
const zkAbi = parseAbi(["function proofValid(address) view returns (bool)"]);
const REFUSAL = ["NONE", "MANDATE_UNSET", "UNKNOWN_GRANT", "REVOKED", "KILLED", "NOT_STARTED", "EXPIRED", "NOT_GRANTEE", "AGENT_WALLET_UNSET", "OUT_OF_SCOPE", "COUNTERPARTY_NOT_ALLOWED", "TOKEN_NOT_ALLOWED", "OVER_PER_TX", "OVER_PERIOD", "OVER_SECOND_WINDOW", "UNDESCRIBED_ACTION", "OUTFLOW_EXCEEDS_DESCRIBED", "FORBIDDEN_TARGET", "ENVELOPE_INVALID", "ENVELOPE_CONFLICT"];

const granteeFromEnv = process.env.B2_GRANTEE_HOT_KEY;
const grantee = privateKeyToAccount(
  granteeFromEnv
    ? ((granteeFromEnv.startsWith("0x") ? granteeFromEnv : `0x${granteeFromEnv}`) as Hex)
    : keccak256(stringToHex("nablaz phase0 fork-only grantee")),
);

let anvil: Anvil;
let pub: PublicClient;
let test: ReturnType<typeof createTestClient>;
let wallet: ReturnType<typeof createWalletClient>;
let seller: Seller;
const report: Record<string, unknown> = { forkBlock: FORK_BLOCK, granteeKeySource: granteeFromEnv ? "B2_GRANTEE_HOT_KEY" : "fork-only key", grantee: grantee.address };

// State carried between steps (the steps are one ordered scenario on one fork).
const S = {} as {
  start: bigint;
  expiry: bigint;
  key: Hex;
  grantId: Hex;
  vault: Address;
  pay: GrantPayment;
  firstHeader: string;
  firstNonce: Hex;
};

/** Every facilitator call the seller makes, in order. */
const calls: { op: "verify" | "settle"; result: VerifyResponse | SettleResponse }[] = [];

const exec = async (from: Address, to: Address, data: Hex) => {
  const hash = await wallet.sendTransaction({ account: from, to, data, chain: arbitrum });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
};
const usdc = (a: Address) => pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [a] });
const balances = async () => ({ payTo: await usdc(PAY_TO), vault: await usdc(S.vault), test: await usdc(TEST), other: await usdc(OTHER_PAYEE) });
const recordEntries = (logs: Parameters<typeof parseEventLogs>[0]["logs"]) =>
  parseEventLogs({ abi: NablaRecordAbi, eventName: "RecordEntry", logs }).filter((l) => getAddress(l.address) === C.NablaRecord.address);
const camCheck = (to: Address, amount: bigint) =>
  pub
    .readContract({
      address: C.ConsumerAIMandateV4.address,
      abi: ConsumerAIMandateV4Abi,
      functionName: "check",
      args: [TEST, S.grantId, grantee.address, { kind: KIND("PAY"), actionKey: PAY_ACTION_KEY, token: USDC, amount, counterparty: to }, false],
    })
    .then((r) => REFUSAL[Number(r)]);

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

/** A fetch that remembers the PAYMENT-SIGNATURE header it sent. */
function capturingFetch(seen: string[]): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const h = req.headers.get("payment-signature");
    if (h) seen.push(h);
    return fetch(req);
  };
}

/** One request through a refused path: refusal at verify, no settle, no balance moved. */
async function expectRefusedAtVerify(doRequest: () => Promise<Response>) {
  const before = await balances();
  const n = calls.length;
  const res = await doRequest();
  const mine = calls.slice(n);
  expect(res.status).toBe(402);
  expect(mine.map((c) => c.op)).toEqual(["verify"]);
  const v = mine[0]!.result as VerifyResponse;
  expect(v.isValid).toBe(false);
  expect(await balances()).toEqual(before);
  return { httpStatus: res.status, verify: v, balances: before };
}

beforeAll(async () => {
  anvil = await startAnvil(FORK_BLOCK);
  const transport = http(anvil.url);
  pub = createPublicClient({ chain: arbitrum, transport }) as PublicClient;
  test = createTestClient({ chain: arbitrum, mode: "anvil", transport });
  wallet = createWalletClient({ chain: arbitrum, transport });
  for (const a of [HOLDER, FACILITATOR, USDC_WHALE]) {
    await test.impersonateAccount({ address: a });
    await test.setBalance({ address: a, value: 10n ** 21n });
  }
  // Deal 2 USDC to the TEST account.
  await exec(USDC_WHALE, USDC, encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [TEST, 2_000_000n] }));
  S.start = (await pub.getBlock()).timestamp;
  S.expiry = S.start + 7n * 86_400n;
  S.key = granteeKeyOf(grantee.address, 0n);
  seller = await startSeller({
    facilitator: localFacilitator(),
    network: NETWORK,
    maxTimeoutSeconds: SELLER_WINDOW,
    routes: [
      { path: "/paid", payTo: PAY_TO, price: "$0.01" },
      { path: "/over-per-tx", payTo: PAY_TO, price: { amount: "1000001", asset: USDC, extra: { name: "USD Coin", version: "2" } } },
      { path: "/other-payee", payTo: OTHER_PAYEE, price: "$0.01" },
    ],
  });
}, 120_000);

afterAll(async () => {
  // Addresses, hashes and amounts only. PHASE0_REPORT: also write it to that path.
  const json = JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  console.log(json);
  if (process.env.PHASE0_REPORT) writeFileSync(process.env.PHASE0_REPORT, json);
  await seller?.close();
  await anvil?.stop();
});

describe("S186 B2 Phase 0 on an Arbitrum One fork", () => {
  it("§4.1 precondition: Conservative tier, no proof, and reservePayment is not gated", async () => {
    const tier = await pub.readContract({ address: TEST, abi: NablaAccountV3_1Abi, functionName: "riskTier" });
    const proofValid = await pub.readContract({ address: ZK_GATE, abi: zkAbi, functionName: "proofValid", args: [TEST] });
    const impl = await pub.getStorageAt({ address: TEST, slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" });
    report["4.1"] = { riskTier: tier, zkGateProofValid: proofValid, implSlot: impl, testUsdcAfterDeal: await usdc(TEST) };
    expect(tier).toBe(0);
    expect(proofValid).toBe(false);
    expect(getAddress(`0x${impl!.slice(-40)}`)).toBe(C.NablaAccountV3_1.address);
    expect(await usdc(TEST)).toBe(2_000_000n);
    // That reservePayment then succeeds with no proof is asserted in §4.3.
  });

  it("§4.2 grant: holder grants the hot key 2 USDC, 1 USDC per tx, payee allowlisted, USDC transfer in scope", async () => {
    const spec = {
      grantee: grantee.address,
      agentId: 0n,
      expiry: S.expiry,
      allowances: [
        { tokenAddress: USDC, periodAmount: 2_000_000n, periodDuration: 0, startTime: S.start, perTx: 1_000_000n, secondWindow: { periodAmount: 0n, periodDuration: 0 } },
      ],
      counterparties: [PAY_TO],
      // GranteeVaultV2 L169-172: the vault checks Action(PAY, keccak256(abi.encodePacked(token, transfer.selector)), …).
      scope: [PAY_ACTION_KEY],
      descriptors: [],
    } as const;
    const nonce = await pub.readContract({ address: C.ConsumerAIMandateV4.address, abi: ConsumerAIMandateV4Abi, functionName: "grantNonce", args: [TEST] });
    const r = await exec(HOLDER, TEST, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "grant", args: [spec] }));
    const [e] = recordEntries(r.logs);
    S.grantId = e!.args.writerAuth;
    const derived = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }], [42161n, TEST, S.key, nonce]));
    const g = await pub.readContract({ address: C.ConsumerAIMandateV4.address, abi: ConsumerAIMandateV4Abi, functionName: "grantOf", args: [TEST, S.grantId] });
    const [wallet_, key] = await pub.readContract({ address: C.ConsumerAIMandateV4.address, abi: ConsumerAIMandateV4Abi, functionName: "granteeOf", args: [TEST, S.grantId] });
    report["4.2"] = { tx: r.transactionHash, grantNonceBefore: nonce, grantId: S.grantId, derivedGrantId: derived, granteeKey: S.key, entry: e!.args, grantOf: g, granteeOf: [wallet_, key] };
    expect(e!.args.kind).toBe(KIND("GRANT_SET"));
    expect(e!.args.subject).toBe(TEST);
    expect(e!.args.counterparty).toBe(grantee.address);
    expect(S.grantId).toBe(derived);
    expect(g.grantee).toBe(grantee.address);
    expect(g.agentId).toBe(0n);
    expect(g.granteeKey).toBe(S.key);
    expect(g.expiry).toBe(S.expiry);
    expect(g.revoked).toBe(false);
    expect(g.killed).toBe(false);
    expect(g.allowances).toHaveLength(1);
    expect(g.allowances[0]!.allowance).toEqual({ ...spec.allowances[0], tokenAddress: USDC });
    expect(g.counterparties).toEqual([PAY_TO]);
    expect(g.scope).toEqual([PAY_ACTION_KEY]);
    expect(g.descriptors).toEqual([]);
    expect(wallet_).toBe(grantee.address);
    expect(key).toBe(S.key);
  });

  it("§4.3 reserve: holder funds the vault; vault = granteeVault(key) = SDK prediction; PAY_AUTHORIZED", async () => {
    const predicted = await vaultOf(pub, TEST, S.key);
    const onchain = await pub.readContract({ address: TEST, abi: NablaAccountV3_1Abi, functionName: "granteeVault", args: [S.key] });
    expect(await pub.getCode({ address: predicted })).toBeUndefined();
    const data = encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "reservePayment", args: [S.grantId, USDC, 2_000_000n, S.expiry] });
    const { result } = await pub.simulateContract({ address: TEST, abi: NablaAccountV3_1Abi, functionName: "reservePayment", args: [S.grantId, USDC, 2_000_000n, S.expiry], account: HOLDER });
    const r = await exec(HOLDER, TEST, data);
    S.vault = result[0];
    const code = (await pub.getCode({ address: S.vault }))!;
    const runtime = concat([
      "0x363d3d373d3d3d363d73",
      C.GranteeVaultV2.address,
      "0x5af43d82803e903d91602b57fd5bf3",
      encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [TEST, S.key]),
    ]).toLowerCase();
    const entries = recordEntries(r.logs);
    const pa = entries.find((x) => x.args.kind === KIND("PAY_AUTHORIZED"))!;
    const [envGrant, envExpiry] = await pub.readContract({ address: C.ConsumerAIMandateV4.address, abi: ConsumerAIMandateV4Abi, functionName: "envelopeOf", args: [TEST, S.key, USDC] });
    const g = await pub.readContract({ address: C.ConsumerAIMandateV4.address, abi: ConsumerAIMandateV4Abi, functionName: "grantOf", args: [TEST, S.grantId] });
    const bal = await balances();
    report["4.3"] = {
      tx: r.transactionHash,
      returned: { vault: result[0], topUp: result[1] },
      granteeVault: onchain,
      sdkPrediction: predicted,
      vaultCode: code,
      vaultUsdc: bal.vault,
      testUsdc: bal.test,
      payAuthorized: pa.args,
      envelopeOf: { grantId: envGrant, expiry: envExpiry },
      allowanceAfterFunding: { spent: g.allowances[0]!.spent, remaining: g.allowances[0]!.remaining },
      kindsInTx: entries.map((x) => x.args.kind),
    };
    expect(S.vault).toBe(onchain);
    expect(S.vault).toBe(predicted);
    expect(result[1]).toBe(2_000_000n);
    expect(code.toLowerCase()).toBe(runtime);
    expect(bal.vault).toBe(2_000_000n);
    expect(bal.test).toBe(0n);
    expect(pa.args).toMatchObject({ subject: TEST, writerAuth: S.grantId, asset: USDC, amount: 2_000_000n, counterparty: grantee.address, counterpartyAuth: pad(S.vault, { size: 32 }).toLowerCase() });
    expect(envGrant).toBe(S.grantId);
    expect(envExpiry).toBe(S.expiry);
    expect(g.allowances[0]!.spent).toBe(2_000_000n);
  });

  it("§4.4-4.5 one $0.01 payment: 402 → payment header → verify OK → settle OK, from the vault", async () => {
    const sent: string[] = [];
    S.pay = await payInsideGrant({ publicClient: pub, account: TEST, grantId: S.grantId, token: USDC, grantee, fetch: capturingFetch(sent) });
    expect(S.pay.vault).toBe(S.vault);
    expect(S.pay.expiry).toBe(S.expiry);
    const before = await balances();
    const n = calls.length;
    const t0 = BigInt(Math.floor(Date.now() / 1000));
    const res = await S.pay.fetch(`${seller.url}/paid`);
    const t1 = BigInt(Math.floor(Date.now() / 1000));
    const mine = calls.slice(n);
    expect(sent).toHaveLength(1);
    S.firstHeader = sent[0]!;
    const payload = decodePaymentSignatureHeader(S.firstHeader) as PaymentPayload & { payload: { authorization: Record<string, string>; signature: Hex } };
    const auth = payload.payload.authorization;
    S.firstNonce = auth.nonce as Hex;
    const settle = mine.find((c) => c.op === "settle")!.result as SettleResponse;
    const receipt = await pub.getTransactionReceipt({ hash: settle.transaction as Hex });
    const tx = await pub.getTransaction({ hash: settle.transaction as Hex });
    const usdcLogs = parseEventLogs({ abi: usdcAbi, logs: receipt.logs }).filter((l) => getAddress(l.address) === USDC);
    const after = await balances();
    // The grantee signed exactly what the live vault clone computes as granteeDigest.
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [keccak256(stringToHex("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")), S.vault, PAY_TO, 10_000n, 0n, BigInt(auth.validBefore!), S.firstNonce],
      ),
    );
    const domainSeparator = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "DOMAIN_SEPARATOR" });
    const vaultDigest = await pub.readContract({ address: S.vault, abi: GranteeVaultV2Abi, functionName: "granteeDigest", args: [domainSeparator, structHash] });
    const sdkDigest = hashTypedData(granteeTypedData({ name: "USD Coin", version: "2", chainId: 42161, verifyingContract: USDC }, S.vault, 42161, { from: S.vault, to: PAY_TO, value: 10_000n, validAfter: 0n, validBefore: BigInt(auth.validBefore!), nonce: S.firstNonce }));
    report["4.5"] = {
      httpStatus: res.status,
      facilitatorCalls: mine,
      authorization: auth,
      validBeforeRule: { envelopeExpiry: S.expiry, sellerMaxTimeoutSeconds: SELLER_WINDOW, wallClockAtRequest: [t0, t1] },
      accepted: payload.accepted,
      signatureBytes: (payload.payload.signature.length - 2) / 2,
      settleTx: settle.transaction,
      settleSelector: tx.input.slice(0, 10),
      settleCalldataBytes: (tx.input.length - 2) / 2,
      usdcEvents: usdcLogs.map((l) => ({ logIndex: l.logIndex, event: l.eventName, args: l.args })),
      balancesBefore: before,
      balancesAfter: after,
      granteeDigest: { vault: vaultDigest, sdk: sdkDigest },
    };
    expect(res.status).toBe(200);
    expect(mine.map((c) => c.op)).toEqual(["verify", "settle"]);
    expect((mine[0]!.result as VerifyResponse).isValid).toBe(true);
    expect(settle.success).toBe(true);
    expect(getAddress(auth.from!)).toBe(S.vault);
    expect(getAddress(auth.to!)).toBe(PAY_TO);
    expect(auth.value).toBe("10000");
    // R-S186-1: validBefore = min(envelope expiry, now + seller window); the seller's window is not stretched.
    const vb = BigInt(auth.validBefore!);
    expect(S.expiry).toBeGreaterThan(t1 + BigInt(SELLER_WINDOW)); // the envelope is days out, so the window binds
    expect(vb).toBeGreaterThanOrEqual(t0 + BigInt(SELLER_WINDOW));
    expect(vb).toBeLessThanOrEqual(t1 + BigInt(SELLER_WINDOW));
    expect(payload.accepted.maxTimeoutSeconds).toBe(SELLER_WINDOW);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(vaultDigest).toBe(sdkDigest);
    expect(usdcLogs.map((l) => l.eventName)).toEqual(["AuthorizationUsed", "Transfer"]);
    expect(usdcLogs[0]!.args).toEqual({ authorizer: S.vault, nonce: S.firstNonce });
    expect(usdcLogs[1]!.args).toEqual({ from: S.vault, to: PAY_TO, value: 10_000n });
    expect(after.payTo - before.payTo).toBe(10_000n);
    expect(after.vault).toBe(1_990_000n);
    expect(after.test).toBe(0n);
  });

  it("§4.6 prep: a settlement whose calldata carries an ERC-8021 suffix (as CDP's does) settles the same way", async () => {
    // A fresh authorization from the same official client path, submitted with a trailing suffix.
    const p = await S.pay.client.createPaymentPayload({
      x402Version: 2,
      resource: { url: `${seller.url}/paid` },
      accepts: [{ scheme: "exact", network: NETWORK, asset: USDC, amount: "10000", payTo: PAY_TO, maxTimeoutSeconds: SELLER_WINDOW, extra: { name: "USD Coin", version: "2" } }],
    } as never);
    const a = (p.payload as { authorization: Record<string, string>; signature: Hex });
    const data = concat([
      encodeFunctionData({
        abi: usdcAbi,
        functionName: "transferWithAuthorization",
        args: [S.vault, PAY_TO, 10_000n, 0n, BigInt(a.authorization.validBefore!), a.authorization.nonce as Hex, a.signature],
      }),
      ERC8021_SUFFIX,
    ]);
    const before = await balances();
    const r = await exec(FACILITATOR, USDC, data);
    const tx = await pub.getTransaction({ hash: r.transactionHash });
    report["4.6-suffixed"] = { tx: r.transactionHash, calldataEndsWithSuffix: tx.input.toLowerCase().endsWith(ERC8021_SUFFIX.slice(2).toLowerCase()), nonce: a.authorization.nonce };
    expect(tx.input.toLowerCase().endsWith(ERC8021_SUFFIX.slice(2).toLowerCase())).toBe(true);
    expect((await balances()).vault).toBe(before.vault - 10_000n);
  });

  it("§4.7a refused at verify: value 1_000_001 (over perTx)", async () => {
    S.pay.client.setSpendControls(false); // the client's own $1 cap would stop it before the seller
    const f = wrapFetchWithPayment(fetch, S.pay.client);
    const out = await expectRefusedAtVerify(() => f(`${seller.url}/over-per-tx`));
    report["4.7a"] = { ...out, camCheck: await camCheck(PAY_TO, 1_000_001n) };
    expect(report["4.7a"]).toMatchObject({ camCheck: "OVER_PER_TX" });
  });

  it("§4.7b refused at verify: payTo not allowlisted", async () => {
    const out = await expectRefusedAtVerify(() => S.pay.fetch(`${seller.url}/other-payee`));
    report["4.7b"] = { ...out, camCheck: await camCheck(OTHER_PAYEE, 10_000n) };
    expect(report["4.7b"]).toMatchObject({ camCheck: "COUNTERPARTY_NOT_ALLOWED" });
  });

  it("§4.7c refused at verify: the first authorization replayed", async () => {
    const out = await expectRefusedAtVerify(() => fetch(`${seller.url}/paid`, { headers: { "PAYMENT-SIGNATURE": S.firstHeader } }));
    report["4.7c"] = out;
  });

  it("§4.7d after kill(): refused at verify; after unkill(): a fresh payment settles", async () => {
    const k = await exec(HOLDER, TEST, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "kill" }));
    const killed = await expectRefusedAtVerify(() => S.pay.fetch(`${seller.url}/paid`));
    const checkWhileKilled = await camCheck(PAY_TO, 10_000n);
    const u = await exec(HOLDER, TEST, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "unkill" }));
    const before = await balances();
    const n = calls.length;
    const res = await S.pay.fetch(`${seller.url}/paid`);
    const mine = calls.slice(n);
    const after = await balances();
    report["4.7d"] = {
      killTx: k.transactionHash,
      killEntry: recordEntries(k.logs).map((e) => e.args),
      whileKilled: { ...killed, camCheck: checkWhileKilled },
      unkillTx: u.transactionHash,
      unkillEntry: recordEntries(u.logs).map((e) => e.args),
      afterUnkill: { httpStatus: res.status, facilitatorCalls: mine, balancesBefore: before, balancesAfter: after },
    };
    expect(checkWhileKilled).toBe("KILLED");
    expect(res.status).toBe(200);
    expect(mine.map((c) => c.op)).toEqual(["verify", "settle"]);
    expect((mine[1]!.result as SettleResponse).success).toBe(true);
    expect(after.payTo - before.payTo).toBe(10_000n);
    expect(before.vault - after.vault).toBe(10_000n);
  });

  it("§4.8 sweep: holder sweeps the vault back to the account; VAULT_SWEPT", async () => {
    const before = await balances();
    const r = await exec(HOLDER, TEST, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "sweepGranteeVault", args: [S.key, USDC] }));
    const after = await balances();
    const [e] = recordEntries(r.logs);
    report["4.8"] = { tx: r.transactionHash, balancesBefore: before, balancesAfter: after, entry: e?.args };
    expect(after.vault).toBe(0n);
    expect(after.test).toBe(before.vault);
    expect(e!.args).toMatchObject({ kind: KIND("VAULT_SWEPT"), subject: TEST, writerAuth: S.grantId, counterparty: S.vault, counterpartyAuth: S.key, asset: USDC, amount: before.vault });
  });

  it("§4.6 reader: B1 pairs every settlement to the grant and vault by events, suffix or not", async () => {
    // eth_blockNumber directly: viem caches getBlockNumber.
    const endBlock = Number(await pub.request({ method: "eth_blockNumber" }));
    // Ponder treats blocks within 180 s of head as unfinalized; one later block puts the scenario behind it.
    await test.increaseTime({ seconds: 3600 });
    await test.mine({ blocks: 1 });
    const { tables } = await indexOnce({ rpcUrl: anvil.url, startBlock: C.GranteeVaultV2.deployBlock, endBlock, cwd: READER_DIR });
    const lc = (x: unknown) => String(x).toLowerCase();
    const mineEntries = tables.record_entries.filter((r) => lc(r.subject) === lc(TEST));
    const vaultRow = tables.vaults.find((r) => lc(r.vault) === lc(S.vault));
    const payments = tables.vault_payments.filter((r) => lc(r.vault) === lc(S.vault));
    report["4.6"] = {
      indexedFrom: C.GranteeVaultV2.deployBlock,
      indexedTo: endBlock,
      recordEntriesForTest: mineEntries.map((r) => ({ block: r.block_number, kind: r.kind_name ?? r.kind, writerAuth: r.writer_auth, amount: r.amount })),
      vault: vaultRow,
      payments: payments.map((p) => ({
        tx: p.tx_hash,
        nonce: p.nonce,
        payee: p.payee,
        value: p.value,
        transferLogIndex: p.transfer_log_index,
        grantIdFromLogs: p.grant_id_from_logs,
        envelopeStatus: p.envelope_status,
        envelopeExpiry: p.envelope_expiry,
        grantMatchesEnvelope: p.grant_matches_envelope,
      })),
    };
    expect(vaultRow).toMatchObject({ create2_matches: true, funding_transfer_seen: true });
    expect(lc(vaultRow!.grantee)).toBe(lc(grantee.address));
    // Three settlements: §4.5, the suffixed one, and the one after unkill. None of the refused ones.
    expect(payments).toHaveLength(3);
    for (const p of payments) {
      expect(lc(p.payee)).toBe(lc(PAY_TO));
      expect(BigInt(String(p.value))).toBe(10_000n);
      expect(p.transfer_log_index).not.toBeNull();
      expect(lc(p.grant_id_from_logs)).toBe(lc(S.grantId));
      expect(p.grant_matches_envelope).toBe(true);
    }
    const kinds = mineEntries.map((r) => r.kind_name);
    expect(kinds).toEqual(expect.arrayContaining(["ACCOUNT_OPENED", "GRANT_SET", "PAY_AUTHORIZED", "KILL_SWITCH", "VAULT_SWEPT"]));
    expect(kinds).not.toContain(null);
  });
});
