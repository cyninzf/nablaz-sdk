// S184 B2 Phase 0: prove the premises on an anvil fork of Arbitrum One (live permanent stack, live USDC),
// driven from TypeScript with the published ABIs and the OFFICIAL x402 packages, unpatched.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
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
  toFunctionSelector,
  zeroHash,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { wrapTypedDataSignature } from "viem/experimental/erc7739";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  ConsumerAIMandateV4Abi,
  GranteeVaultAbi,
  NablaAccountFactoryPermanentAbi,
  NablaAccountV3Abi,
  NablaRecordAbi,
} from "../../src/generated/abis";
import { ARBITRUM_ONE } from "../../src/generated/addresses";
import { startAnvil, type Anvil } from "./anvil";

const C = ARBITRUM_ONE.contracts;
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WHALE: Address = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
const NETWORK = "eip155:42161" as const;
const usdcAbi = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);
const TWA_TYPES = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;
const TYPED_DATA_SIGN = (contents: string) => [
  { name: "contents", type: contents },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];
const AUTHORIZATION = [
  {
    type: "tuple",
    components: [
      { name: "grantId", type: "bytes32" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "granteeSignature", type: "bytes" },
    ],
  },
] as const;

let anvil: Anvil;
let pub: ReturnType<typeof createPublicClient>;
let test: ReturnType<typeof createTestClient>;
let wallet: ReturnType<typeof createWalletClient>;
const report: Record<string, unknown> = {};

const actor = async (a: Address) => {
  await test.impersonateAccount({ address: a });
  await test.setBalance({ address: a, value: 10n ** 24n });
  return a;
};
const exec = async (from: Address, to: Address, data: Hex) => {
  const hash = await wallet.sendTransaction({ account: from, to, data, chain: arbitrum });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
};
const chainNow = async () => (await pub.getBlock()).timestamp;

/** Account created by its owner, funded, one grant to `grantee` paying `payee`. */
async function accountWithGrant(owner: Address, grantee: Address, payee: Address) {
  const r = await exec(
    owner,
    C.NablaAccountFactoryPermanent.address,
    encodeFunctionData({ abi: NablaAccountFactoryPermanentAbi, functionName: "createAccount", args: [[]] }),
  );
  const account = parseEventLogs({ abi: NablaAccountFactoryPermanentAbi, eventName: "AccountCreated", logs: r.logs })[0]!
    .args.account;
  await exec(await actor(WHALE), USDC, encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [account, 500_000_000n] }));
  const start = await chainNow();
  const g = await exec(
    owner,
    account,
    encodeFunctionData({
      abi: NablaAccountV3Abi,
      functionName: "grant",
      args: [
        {
          grantee,
          agentId: 0n,
          expiry: start + 30n * 86400n,
          allowances: [
            {
              tokenAddress: USDC,
              periodAmount: 50_000_000n,
              periodDuration: 86400,
              startTime: start,
              perTx: 10_000_000n,
              secondWindow: { periodAmount: 80_000_000n, periodDuration: 7 * 86400 },
            },
          ],
          counterparties: [payee],
          scope: [keccak256(concat([USDC, toFunctionSelector("transfer(address,uint256)")]))],
          descriptors: [],
        },
      ],
    }),
  );
  const grantSet = parseEventLogs({ abi: NablaRecordAbi, eventName: "RecordEntry", logs: g.logs })[0]!;
  const grantId = grantSet.args.writerAuth;
  const key = await pub.readContract({
    abi: ConsumerAIMandateV4Abi,
    address: C.ConsumerAIMandateV4.address,
    functionName: "granteeKeyOf",
    args: [grantee, 0n],
  });
  const vault = await pub.readContract({ abi: NablaAccountV3Abi, address: account, functionName: "granteeVault", args: [key] });
  return { account, grantId, key, vault, start };
}

/** Phase 0 prototype of the vault signer: address = vault; signature = the 7739-wrapped grantee signature. */
function vaultSigner(grantee: LocalAccount, vault: Address, grantId: Hex): ClientEvmSigner {
  return {
    address: vault,
    async signTypedData({ domain, types, primaryType, message }) {
      if (primaryType !== "TransferWithAuthorization") throw new Error("vault signs EIP-3009 only");
      const m = message as { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
      const granteeSignature = await grantee.signTypedData({
        domain: domain as never,
        types: { TypedDataSign: TYPED_DATA_SIGN("TransferWithAuthorization"), TransferWithAuthorization: TWA_TYPES },
        primaryType: "TypedDataSign",
        message: {
          contents: m,
          name: "NablaZGranteeVault",
          version: "1",
          chainId: BigInt(arbitrum.id),
          verifyingContract: vault,
          salt: zeroHash,
        },
      });
      void types;
      return encodeAbiParameters(AUTHORIZATION, [
        { grantId, to: m.to, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore), nonce: m.nonce, granteeSignature },
      ]);
    },
  };
}

function facilitatorFor(address: Address) {
  const client = createWalletClient({ account: address, chain: arbitrum, transport: http(anvil.url) }).extend(publicActions);
  const signer = toFacilitatorEvmSigner({
    address,
    readContract: (a) => client.readContract(a as never),
    verifyTypedData: (a) => client.verifyTypedData(a as never),
    writeContract: (a) => client.writeContract({ ...(a as object), account: address, chain: arbitrum } as never),
    sendTransaction: (a) => client.sendTransaction({ ...a, account: address, chain: arbitrum }),
    waitForTransactionReceipt: (a) => client.waitForTransactionReceipt(a),
    getCode: (a) => client.getCode(a),
  });
  return new x402Facilitator().register(NETWORK, new ExactEvmFacilitatorScheme(signer));
}

beforeAll(async () => {
  anvil = await startAnvil();
  const transport = http(anvil.url);
  pub = createPublicClient({ chain: arbitrum, transport });
  test = createTestClient({ chain: arbitrum, mode: "anvil", transport });
  wallet = createWalletClient({ chain: arbitrum, transport });
});

afterAll(async () => {
  console.log(JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  await anvil?.stop();
});

describe("P0-3 + P0-1 + P0-2: x402 through a GranteeVault", () => {
  it("vault has code before its first payment; official client builds the payload; official facilitator verifies and settles", async () => {
    const owner = await actor(getAddress("0x00000000000000000000000000000000000b2001"));
    const grantee = privateKeyToAccount(pad("0xb2a6e1", { size: 32 }));
    await actor(grantee.address);
    const payee = getAddress("0x00000000000000000000000000000000000a9eb2");
    const facilitatorAddr = await actor(getAddress("0x00000000000000000000000000000000000fac22"));
    const { account, grantId, vault, start } = await accountWithGrant(owner, grantee.address, payee);

    // P0-3: reservePayment deploys the vault (clone) and funds it; the vault has code before any payment.
    expect(await pub.getCode({ address: vault })).toBeUndefined();
    const reserve = await exec(
      grantee.address,
      account,
      encodeFunctionData({ abi: NablaAccountV3Abi, functionName: "reservePayment", args: [grantId, USDC, 30_000_000n, start + 86400n] }),
    );
    const code = await pub.getCode({ address: vault });
    report.P0_3 = { deployTx: reserve.transactionHash, block: reserve.blockNumber, vault, codeBytes: code ? (code.length - 2) / 2 : 0 };
    expect(code && code !== "0x").toBeTruthy();

    // Grantee digest parity: the TypedDataSign hash the adapter signs == vault.granteeDigest.
    const tokenDomain = { name: await pub.readContract({ abi: usdcAbi, address: USDC, functionName: "name" }), version: await pub.readContract({ abi: usdcAbi, address: USDC, functionName: "version" }), chainId: arbitrum.id, verifyingContract: USDC } as const;
    const sampleMsg = { from: vault, to: payee, value: 1n, validAfter: 0n, validBefore: 2n, nonce: pad("0x01", { size: 32 }) };
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [keccak256(new TextEncoder().encode("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")), vault, payee, 1n, 0n, 2n, sampleMsg.nonce],
      ),
    );
    const onchain = await pub.readContract({
      abi: GranteeVaultAbi,
      address: vault,
      functionName: "granteeDigest",
      args: [await pub.readContract({ abi: usdcAbi, address: USDC, functionName: "DOMAIN_SEPARATOR" }), structHash],
    });
    const local = hashTypedData({
      domain: tokenDomain,
      types: { TypedDataSign: TYPED_DATA_SIGN("TransferWithAuthorization"), TransferWithAuthorization: TWA_TYPES },
      primaryType: "TypedDataSign",
      message: { contents: sampleMsg, name: "NablaZGranteeVault", version: "1", chainId: BigInt(arbitrum.id), verifyingContract: vault, salt: zeroHash },
    });
    expect(local).toBe(onchain);

    // A resource server: 402 with requirements, then verify + settle through the official facilitator.
    const facilitator = facilitatorFor(facilitatorAddr);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: NETWORK,
      asset: USDC,
      amount: "1000000",
      payTo: payee,
      maxTimeoutSeconds: 300,
      extra: { name: tokenDomain.name, version: tokenDomain.version },
    };
    const paymentRequired: PaymentRequired = { x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts: [requirements] };
    const seen: { verify?: unknown; settle?: unknown; settleError?: string; payload?: unknown } = {};
    const server: Server = createServer(async (req, res) => {
      const header = req.headers["payment-signature"];
      if (!header) {
        res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired), "content-type": "application/json" });
        res.end(JSON.stringify(paymentRequired));
        return;
      }
      const payload = decodePaymentSignatureHeader(String(header));
      seen.payload = payload;
      const v = await facilitator.verify(payload, requirements);
      seen.verify = v;
      if (!v.isValid) {
        res.writeHead(402).end(JSON.stringify(v));
        return;
      }
      try {
        const s = await facilitator.settle(payload, requirements);
        seen.settle = s;
        res.writeHead(200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(s) }).end("ok");
      } catch (e) {
        seen.settleError = String(e);
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`;

    // P0-2: the official client + fetch wrapper with only our adapter as signer.
    const client = new x402Client().register(NETWORK, new ExactEvmClientScheme(vaultSigner(grantee, vault, grantId)));
    const paidFetch = wrapFetchWithPayment(fetch, client);
    const resp = await paidFetch(url);
    server.close();

    const payload = seen.payload as { payload: { authorization: { from: string }; signature: Hex } } | undefined;
    report.P0_2 = { clientProducedPayload: !!payload, from: payload?.payload.authorization.from, signatureBytes: payload ? (payload.payload.signature.length - 2) / 2 : 0 };
    expect(payload?.payload.authorization.from.toLowerCase()).toBe(vault.toLowerCase());

    report.P0_1_verify = seen.verify;
    report.P0_1_settle = seen.settle ?? seen.settleError ?? "not reached (verify returned invalid)";
    report.P0_1_httpStatus = resp.status;

    // Diagnostic: the same payload, submitted on chain directly (msg.sender of isValidSignature = USDC).
    const auth = (seen.payload as { payload: { authorization: Record<string, string>; signature: Hex } }).payload;
    const direct = await exec(
      facilitatorAddr,
      USDC,
      encodeFunctionData({
        abi: usdcAbi,
        functionName: "transferWithAuthorization",
        args: [vault, payee, BigInt(auth.authorization.value!), BigInt(auth.authorization.validAfter!), BigInt(auth.authorization.validBefore!), auth.authorization.nonce as Hex, auth.signature],
      }),
    ).catch((e) => ({ error: String(e).slice(0, 200) }));
    report.P0_1_direct_onchain =
      "logs" in direct
        ? direct.logs.map((l) => {
            try {
              const d = decodeEventLog({ abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"]), data: l.data, topics: l.topics });
              return { logIndex: l.logIndex, event: d.eventName };
            } catch {
              return { logIndex: l.logIndex, event: "other" };
            }
          })
        : direct;

    // Diagnostic: what the vault answers when isValidSignature is called directly (as the facilitator does).
    const twaDigest = hashTypedData({
      domain: tokenDomain,
      types: { TransferWithAuthorization: TWA_TYPES },
      primaryType: "TransferWithAuthorization",
      message: {
        from: vault,
        to: payee,
        value: BigInt(auth.authorization.value!),
        validAfter: BigInt(auth.authorization.validAfter!),
        validBefore: BigInt(auth.authorization.validBefore!),
        nonce: auth.authorization.nonce as Hex,
      },
    });
    const isValidFrom = async (from: Address | undefined) =>
      pub.readContract({ abi: parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]), address: vault, functionName: "isValidSignature", args: [twaDigest, auth.signature], account: from });
    report.P0_1_isValidSignature = { fromFacilitator: await isValidFrom(facilitatorAddr), fromUsdc: await isValidFrom(USDC) };

    expect((seen.verify as { isValid: boolean }).isValid, "P0-1 verify").toBe(true);
    expect(resp.status, "P0-1 settled").toBe(200);
  });
});

describe("P0-4: createAccountFor with an external signer", () => {
  it("third-party submitter; holder signature from toAccount; lands at predictAddress; AccountSponsored(owner, submitter)", async () => {
    const hidden = privateKeyToAccount(pad("0xb2c0ffee", { size: 32 })); // stands in for a KMS key
    const external = toAccount({
      address: hidden.address,
      signMessage: (a) => hidden.signMessage(a),
      signTransaction: (a) => hidden.signTransaction(a),
      signTypedData: (a) => hidden.signTypedData(a as never),
    });
    const submitter = await actor(getAddress("0x00000000000000000000000000000000005b2004"));
    const deadline = (await chainNow()) + 3600n;
    const impl = C.NablaAccountV3.address;
    const signature = await external.signTypedData({
      domain: { name: "NablaAccountFactoryPermanent", version: "1", chainId: arbitrum.id, verifyingContract: C.NablaAccountFactoryPermanent.address },
      types: {
        CreateAccount: [
          { name: "owner", type: "address" },
          { name: "implementation", type: "address" },
          { name: "overrideAdapters", type: "address[]" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "CreateAccount",
      message: { owner: external.address, implementation: impl, overrideAdapters: [], deadline },
    });
    const predicted = await pub.readContract({ abi: NablaAccountFactoryPermanentAbi, address: C.NablaAccountFactoryPermanent.address, functionName: "predictAddress", args: [external.address] });
    const r = await exec(
      submitter,
      C.NablaAccountFactoryPermanent.address,
      encodeFunctionData({ abi: NablaAccountFactoryPermanentAbi, functionName: "createAccountFor", args: [external.address, [], deadline, signature] }),
    );
    const sponsored = parseEventLogs({ abi: NablaAccountFactoryPermanentAbi, eventName: "AccountSponsored", logs: r.logs })[0]!;
    report.P0_4 = { tx: r.transactionHash, owner: external.address, submitter, predicted, sponsoredEvent: sponsored.args };
    expect(sponsored.args.owner).toBe(external.address);
    expect(sponsored.args.sponsor).toBe(submitter);
    expect(sponsored.args.account).toBe(predicted);
    expect(await pub.getCode({ address: predicted })).toBeTruthy();
  });
});

describe("P0-5: writeWithConsent from the platform's own address", () => {
  it("consent signed for the account via its ERC-1271 (7739) path; writer = platform; a third-party submitter is refused", async () => {
    const ownerKey = privateKeyToAccount(pad("0xb2005", { size: 32 }));
    const owner = await actor(ownerKey.address);
    const platform = await actor(getAddress("0x00000000000000000000000000000000000b1a75"));
    const thirdParty = await actor(getAddress("0x00000000000000000000000000000000000ab1ab"));
    const r = await exec(owner, C.NablaAccountFactoryPermanent.address, encodeFunctionData({ abi: NablaAccountFactoryPermanentAbi, functionName: "createAccount", args: [[]] }));
    const account = parseEventLogs({ abi: NablaAccountFactoryPermanentAbi, eventName: "AccountCreated", logs: r.logs })[0]!.args.account;

    const kind = keccak256(new TextEncoder().encode("EXTERNAL_ATTESTATION"));
    const consent = { subject: account, writer: platform, kind, counterparty: platform, nonce: 1n, deadline: (await chainNow()) + 3600n };
    const recordDomain = { name: "NablaRecord", version: "1", chainId: arbitrum.id, verifyingContract: C.NablaRecord.address } as const;
    const consentTypes = {
      Consent: [
        { name: "subject", type: "address" },
        { name: "writer", type: "address" },
        { name: "kind", type: "bytes32" },
        { name: "counterparty", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;
    const digestOnchain = await pub.readContract({ abi: NablaRecordAbi, address: C.NablaRecord.address, functionName: "consentDigest", args: [consent] });
    expect(hashTypedData({ domain: recordDomain, types: consentTypes, primaryType: "Consent", message: consent })).toBe(digestOnchain);

    const inner = await ownerKey.signTypedData({
      domain: recordDomain,
      types: { TypedDataSign: TYPED_DATA_SIGN("Consent"), ...consentTypes },
      primaryType: "TypedDataSign",
      message: { contents: consent, name: "NablaAccount", version: "3", chainId: BigInt(arbitrum.id), verifyingContract: account, salt: zeroHash },
    });
    const sig = wrapTypedDataSignature({ domain: recordDomain, types: consentTypes, primaryType: "Consent", message: consent, signature: inner });

    const entry = {
      subject: account,
      kind,
      writerAuth: zeroHash,
      counterparty: platform,
      counterpartyAuth: zeroHash,
      policyHash: zeroHash,
      policyVersion: 0,
      asset: "0x0000000000000000000000000000000000000000" as Address,
      amount: 0n,
      amountCommitment: zeroHash,
      obligationRef: zeroHash,
      source: zeroHash,
    };
    const data = encodeFunctionData({ abi: NablaRecordAbi, functionName: "writeWithConsent", args: [entry, consent, sig] });

    // A third party (e.g. a NablaZ relayer) submitting the platform's consent is refused.
    const refused = await pub
      .simulateContract({ abi: NablaRecordAbi, address: C.NablaRecord.address, functionName: "writeWithConsent", args: [entry, consent, sig], account: thirdParty })
      .then(() => "accepted")
      .catch((e: { walk: (f: (x: unknown) => boolean) => { data?: { errorName?: string } } | null }) => e.walk((x) => !!(x as { data?: { errorName?: string } })?.data?.errorName)?.data?.errorName ?? "reverted (undecoded)");
    report.P0_5_thirdParty = refused;
    expect(refused).toBe("CONSENT_MISMATCH");

    const w = await exec(platform, C.NablaRecord.address, data);
    const e = parseEventLogs({ abi: NablaRecordAbi, eventName: "RecordEntry", logs: w.logs })[0]!;
    report.P0_5 = { tx: w.transactionHash, subject: e.args.subject, writer: e.args.writer, writerAuth: e.args.writerAuth, consentDigest: digestOnchain };
    expect(e.args.writer).toBe(platform);
    expect(e.args.subject).toBe(account);
    expect(e.args.writerAuth).toBe(digestOnchain);
  });
});
