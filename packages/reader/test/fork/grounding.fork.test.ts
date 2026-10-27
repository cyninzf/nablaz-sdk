// R-D2B-2 end to end on an anvil fork of Arbitrum One, against the live permanent stack and the live ERC-8004
// registries. A fork-only key W registers an agentId (its agentWallet is W). A NablaZ account A, created on
// the live factory with a fork-only controller, rates W's agentId before paying, pays W 0.01 USDC from a
// grantee vault (USDC transferWithAuthorization with the vault's ERC-1271 bytes), and rates again. A second
// rater with no payment rates once. The reader indexes the fork from scratch; GET /read of W must carry one
// grounding fact per feedback, cite the vault payment for the grounded one, and never carry a feedback's
// value, decimals, tags or URIs. Read the indexed rows only; no mainnet transaction.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
  toFunctionSelector,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { ARBITRUM_ONE } from "@nablaz/sdk/addresses";
import { NablaAccountFactoryPermanentAbi, NablaAccountV3_1Abi, NablaRecordAbi } from "@nablaz/sdk/abis";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, granteeVaultSigner } from "@nablaz/sdk";
import { CHAINS } from "../../src/chains";
import { indexOnce, startAnvil, type Anvil, type Served } from "./harness";

const C = ARBITRUM_ONE.contracts;
const FORK_BLOCK = 517_955_000;
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WHALE: Address = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
const IDENTITY = CHAINS[42161]!.external.IdentityRegistry!;
const REPUTATION = CHAINS[42161]!.external.ReputationRegistry!;
const PAY_ACTION_KEY = keccak256(concat([USDC, toFunctionSelector("transfer(address,uint256)")]));
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: USDC } as const;
// Distinctive values that must never appear in a read.
const LEAKS = { value: 7_777_777n, tag1: "zz-leak-tag-one", tag2: "zz-leak-tag-two", endpoint: "https://zz-leak-endpoint.example", uri: "ipfs://zz-leak-feedback-uri" };

const key = (s: string) => privateKeyToAccount(keccak256(stringToHex(`nablaz grounding fork ${s}`)));
const agentOwner = key("agent wallet W");
const controller = key("account A controller");
const grantee = key("vault grantee");
const otherRater = key("second rater");

const identityAbi = parseAbi([
  "function register() returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);
const feedbackAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);
const usdcAbi = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);

let anvil: Anvil;
let pub: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let served: Served;
let body: string;
let read: any;
const S = {} as { A: Address; agentId: bigint; grantId: Hex; vault: Address; feedbackTx: Record<string, Hex>; settleTx: Hex; endBlock: number };

const send = async (from: Address | PrivateKeyAccount, to: Address, data: Hex) => {
  const r = await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: from, to, data, chain: arbitrum }) });
  if (r.status !== "success") throw new Error(`reverted: ${r.transactionHash}`);
  return r;
};
const feedbackData = (agentId: bigint) =>
  encodeFunctionData({ abi: feedbackAbi, functionName: "giveFeedback", args: [agentId, LEAKS.value, 2, LEAKS.tag1, LEAKS.tag2, LEAKS.endpoint, LEAKS.uri, zeroHash] });
/** A's controller calls `target` from A (ERC-7579 single call: target ‖ value ‖ calldata). */
const fromA = (target: Address, data: Hex) =>
  send(controller, S.A, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "execute", args: [zeroHash, encodePacked(["address", "uint256", "bytes"], [target, 0n, data])] }));

beforeAll(async () => {
  anvil = await startAnvil(FORK_BLOCK);
  const transport = http(anvil.url);
  pub = createPublicClient({ chain: arbitrum, transport }) as PublicClient;
  wallet = createWalletClient({ chain: arbitrum, transport });
  const test = createTestClient({ chain: arbitrum, mode: "anvil", transport });
  await test.impersonateAccount({ address: WHALE });
  for (const a of [WHALE, agentOwner.address, controller.address, otherRater.address]) await test.setBalance({ address: a, value: 10n ** 21n });
  S.feedbackTx = {};

  // W registers an agentId: register() sets agentWallet = msg.sender.
  const reg = await send(agentOwner, IDENTITY, encodeFunctionData({ abi: identityAbi, functionName: "register" }));
  S.agentId = parseEventLogs({ abi: identityAbi, eventName: "Registered", logs: reg.logs })[0]!.args.agentId;

  // A: a NablaZ account on the live factory, controller = a fork-only key.
  await send(controller, C.NablaAccountFactoryPermanent.address, encodeFunctionData({ abi: NablaAccountFactoryPermanentAbi, functionName: "createAccount", args: [[]] }));
  S.A = await pub.readContract({ address: C.NablaAccountFactoryPermanent.address, abi: NablaAccountFactoryPermanentAbi, functionName: "predictAddress", args: [controller.address] });

  // Feedback 1: the second rater, no payment ever.
  S.feedbackTx.other = (await send(otherRater, REPUTATION, feedbackData(S.agentId))).transactionHash;
  // Feedback 2: A, before it pays.
  S.feedbackTx.before = (await fromA(REPUTATION, feedbackData(S.agentId))).transactionHash;

  // A grants the grantee key 1 USDC, payee W, and reserves it into the grant's vault.
  const start = (await pub.getBlock()).timestamp;
  const expiry = start + 7n * 86_400n;
  const spec = {
    grantee: grantee.address,
    agentId: 0n,
    expiry,
    allowances: [{ tokenAddress: USDC, periodAmount: 1_000_000n, periodDuration: 0, startTime: start, perTx: 100_000n, secondWindow: { periodAmount: 0n, periodDuration: 0 } }],
    counterparties: [agentOwner.address],
    scope: [PAY_ACTION_KEY],
    descriptors: [],
  } as const;
  const g = await send(controller, S.A, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "grant", args: [spec] }));
  S.grantId = parseEventLogs({ abi: NablaRecordAbi, eventName: "RecordEntry", logs: g.logs })[0]!.args.writerAuth;
  await send(WHALE, USDC, encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [S.A, 1_000_000n] }));
  const { result } = await pub.simulateContract({ address: S.A, abi: NablaAccountV3_1Abi, functionName: "reservePayment", args: [S.grantId, USDC, 1_000_000n, expiry], account: controller });
  await send(controller, S.A, encodeFunctionData({ abi: NablaAccountV3_1Abi, functionName: "reservePayment", args: [S.grantId, USDC, 1_000_000n, expiry] }));
  S.vault = result[0];

  // The payment: A's vault → W, 0.01 USDC, settled by an unrelated sender.
  const { timestamp } = await pub.getBlock();
  const granteeKey = keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [0, grantee.address]));
  const signer = granteeVaultSigner({ grantee, account: S.A, vaultImpl: C.GranteeVaultV2.address, granteeKey, vault: S.vault, grantId: S.grantId, token: USDC, chainId: 42161, expiry, maxTimeoutSeconds: 300, now: () => Number(timestamp) });
  const m = { from: S.vault, to: agentOwner.address, value: 10_000n, validAfter: 0n, validBefore: timestamp + 300n, nonce: keccak256(stringToHex("grounding payment")) };
  void hashTypedData({ domain: USDC_DOMAIN, types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES }, primaryType: "TransferWithAuthorization", message: m });
  const sig = await signer.signTypedData({ domain: USDC_DOMAIN, types: {}, primaryType: "TransferWithAuthorization", message: m });
  S.settleTx = (await send(WHALE, USDC, encodeFunctionData({ abi: usdcAbi, functionName: "transferWithAuthorization", args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, sig] }))).transactionHash;

  // Feedback 3: A, after it paid.
  const last = await fromA(REPUTATION, feedbackData(S.agentId));
  S.feedbackTx.after = last.transactionHash;
  S.endBlock = Number(last.blockNumber);
  // Ponder treats blocks within 180 s of head as unfinalized; one block an hour later puts the window behind it.
  await test.setNextBlockTimestamp({ timestamp: (await pub.getBlock()).timestamp + 3_600n });
  await test.mine({ blocks: 1 });

  served = await indexOnce({ rpcUrl: anvil.url, startBlock: FORK_BLOCK + 1, endBlock: S.endBlock, sources: "nabla,external", serve: true });
  body = await (await fetch(`${served.url}/read/42161/${agentOwner.address}`)).text();
  read = JSON.parse(body);
}, 1_200_000);

afterAll(async () => {
  await served?.stop();
  await anvil?.stop();
});

const grounding = () => read.facts.filter((f: any) => f.source === "erc8004:feedback_grounding");
const byTx = (tx: Hex) => grounding().find((f: any) => f.cite.tx === tx);

describe("feedback grounding on an Arbitrum fork", () => {
  it("one grounding fact per feedback about W's agentId, each the rater's attestation (e)", () => {
    console.log(JSON.stringify({ agentId: S.agentId.toString(), A: S.A, W: agentOwner.address, vault: S.vault, settleTx: S.settleTx, feedbackTx: S.feedbackTx, grounding: grounding().map((f: any) => ({ tx: f.cite.tx, block: f.cite.block, ...f.terms, payment: f.terms.payment?.cite })) }, null, 2));
    expect(grounding()).toHaveLength(3);
    for (const f of grounding()) {
      expect(f.shape).toBe("e");
      expect(f.terms.agentId).toBe(S.agentId.toString());
      expect(f.terms.agentWalletAtFeedback).toBe(agentOwner.address);
      expect(f.terms.feedbackURI).toBe("not read");
    }
  });

  it("A's feedback after its vault payment to W is grounded, citing that settlement with its own label", () => {
    const f = byTx(S.feedbackTx.after!);
    expect(f.terms.grounding).toBe("grounded");
    expect(f.terms.payment.source).toBe("nablaz:vault_payment");
    expect(f.terms.payment.cite.tx).toBe(S.settleTx);
    expect(f.terms.payment.payer.toLowerCase()).toBe(S.A.toLowerCase());
    expect(f.terms.payment.label).toBe("(a) within mandate by construction");
    expect(f.terms.payment.terms.authorization.grantIdFromLogs.toLowerCase()).toBe(S.grantId.toLowerCase());
    expect(f.terms.raterIsSubject).toBe(false);
  });

  it("A's feedback before paying, and the second rater's, are not grounded, with the range read", () => {
    for (const tx of [S.feedbackTx.before!, S.feedbackTx.other!]) {
      const f = byTx(tx);
      expect(f.terms.grounding).toBe("not grounded");
      expect(f.terms.reason).toMatch(new RegExp(`^nothing indexed from the rater to this wallet before the feedback \\(blocks ${FORK_BLOCK + 1}\\.\\.\\d+\\)$`));
    }
  });

  it("the controller comparison: A is a NablaZ account, W is not", () => {
    expect(byTx(S.feedbackTx.after!).terms.sameController).toMatch(/^not determinable/);
  });

  it("never carries the feedback's value, decimals, tags, endpoint or URI", () => {
    for (const leak of [LEAKS.value.toString(), LEAKS.tag1, LEAKS.tag2, LEAKS.endpoint, LEAKS.uri]) expect(body).not.toContain(leak);
    // The grounding fact's own terms: the cited payment fact keeps its own fields (a vault payment's value is the
    // settled amount, not the feedback's).
    for (const f of grounding()) {
      const own = Object.keys(f.terms);
      for (const k of ["value", "valueDecimals", "tag1", "tag2", "endpoint", "feedbackHash"]) expect(own).not.toContain(k);
      expect(f.terms.feedbackURI).toBe("not read");
    }
  });

  it("says the feedbackURI is not read, and carries the (c) share per token", () => {
    expect(read.notes).toContain("feedbackURI not read: proofOfPayment and the feedback file are off chain and are not fetched");
    expect(read.cShare).toMatchObject({ chainId: 42161 });
    console.log(`(c) share in /read of W: ${JSON.stringify(read.cShare)}`);
  });
});
