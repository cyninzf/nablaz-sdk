// Replays the Phase 0 cases on an anvil fork of Arbitrum One at block 517348000, against the live
// permanent stack and live USDC, driven from TypeScript with the published ABIs. Returns what each case
// put on chain so the tests can assert the derived rows.

import {
  createTestClient,
  createWalletClient,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  stringToHex,
  toFunctionSelector,
  concat,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { ARBITRUM_ONE } from "@nablaz/sdk/addresses";
import {
  ConsumerAIMandateV4Abi,
  GranteeVaultAbi,
  NablaAccountFactoryPermanentAbi,
  NablaAccountV3Abi,
  NablaRecordAbi,
} from "@nablaz/sdk/abis";

export const FORK_BLOCK = 517_348_000;
export const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WHALE: Address = "0x724dc807b04555b71ed48a6896b6F41593b8C637"; // Aave V3 aUSDC
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const C = ARBITRUM_ONE.contracts;

const usdcAbi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])",
]);
const TWA_TYPEHASH = keccak256(
  stringToHex(
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);

export type Settlement = {
  label: string;
  tx: Hex;
  block: bigint;
  vault: Address;
  account: Address;
  payee: Address;
  value: bigint;
  nonce: Hex;
  submitter: Address;
  grantId: Hex;
  /** The envelope expiry the settlement drew against, from the scenario's own reservations. */
  expectExpiry: bigint | "not determinable";
};

export type CaseRecord = {
  label: string;
  account: Address;
  owner: Address;
  agent: Address;
  vault: Address;
  granteeKey: Hex;
  grantId: Hex;
  payee: Address;
  /** PAY_AUTHORIZED entries written (reservations that topped up something). */
  fundings: number;
  kills: number;
};

export type ObligationRecord = {
  subject: Address;
  lender: Address;
  ref: Hex;
  /** tx hash per write, in order: OPENED, REPAY(ref), REPAY(0), CLOSED. */
  txs: Hex[];
};

export type Scenario = {
  cases: CaseRecord[];
  settlements: Settlement[];
  obligation: ObligationRecord;
  /** The (v) account upgraded to the same implementation: one IMPLEMENTATION_CHANGED + one Upgraded. */
  upgraded: { account: Address; tx: Hex; implementation: Address };
  endBlock: number;
};

export async function runScenario(rpcUrl: string): Promise<Scenario> {
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain: arbitrum, transport });
  const test = createTestClient({ chain: arbitrum, mode: "anvil", transport });
  const wallet = createWalletClient({ chain: arbitrum, transport });

  const now = async () => (await pub.getBlock()).timestamp;
  const warpTo = async (t: bigint) => test.setNextBlockTimestamp({ timestamp: t });
  const warpBy = async (s: bigint) => warpTo((await now()) + s);
  const actor = async (a: Address) => {
    await test.impersonateAccount({ address: a });
    await test.setBalance({ address: a, value: 10n ** 24n });
    return a;
  };
  const send = async (from: Address, to: Address, data: Hex, extra: { maxPriorityFeePerGas?: bigint; gas?: bigint } = {}) => {
    const hash = await wallet.sendTransaction({ account: from, to, data, chain: arbitrum, ...extra });
    return hash;
  };
  const mined = async (hash: Hex): Promise<TransactionReceipt> => {
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`tx reverted: ${hash}`);
    return r;
  };
  const exec = async (from: Address, to: Address, data: Hex) => mined(await send(from, to, data));

  const whale = await actor(WHALE);
  const facilitator = await actor(getAddress("0x00000000000000000000000000000000000fac11"));
  const cases: CaseRecord[] = [];
  const settlements: Settlement[] = [];

  async function setupCase(label: string, n: number) {
    const owner = await actor(getAddress(pad(`0x0b0e${n.toString(16).padStart(2, "0")}`, { size: 20 })));
    const payee = getAddress(pad(`0x0a9e${n.toString(16).padStart(2, "0")}`, { size: 20 }));
    const agentPk = pad(`0xb1a6e${n.toString(16).padStart(2, "0")}`, { size: 32 });
    const agentAcct = privateKeyToAccount(agentPk);
    const agent = await actor(agentAcct.address);

    const r = await exec(
      owner,
      C.NablaAccountFactoryPermanent.address,
      encodeFunctionData({ abi: NablaAccountFactoryPermanentAbi, functionName: "createAccount", args: [[]] }),
    );
    const created = parseEventLogs({ abi: NablaAccountFactoryPermanentAbi, eventName: "AccountCreated", logs: r.logs });
    const account = created[0]!.args.account;
    await exec(whale, USDC, encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [account, 1_000_000_000n] }));

    const start = await now();
    const grantExpiry = start + 30n * 86400n;
    const spec = {
      grantee: agent,
      agentId: 0n,
      expiry: grantExpiry,
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
    } as const;
    await exec(owner, account, encodeFunctionData({ abi: NablaAccountV3Abi, functionName: "grant", args: [spec] }));
    const granteeKey = await pub.readContract({
      abi: ConsumerAIMandateV4Abi,
      address: C.ConsumerAIMandateV4.address,
      functionName: "granteeKeyOf",
      args: [agent, 0n],
    });
    const vault = await pub.readContract({
      abi: NablaAccountV3Abi,
      address: account,
      functionName: "granteeVault",
      args: [granteeKey],
    });
    // grantId from the CAM view, to compare with what the indexer derives from logs.
    const grantId = await grantIdOf(account, granteeKey);
    const rec: CaseRecord = { label, account, owner, agent, vault, granteeKey, grantId, payee, fundings: 0, kills: 0 };
    cases.push(rec);

    const reserve = async (amount: bigint, expiry: bigint) => {
      const before = await pub.readContract({ abi: usdcAbi, address: USDC, functionName: "balanceOf", args: [vault] });
      await exec(
        agent,
        account,
        encodeFunctionData({ abi: NablaAccountV3Abi, functionName: "reservePayment", args: [grantId, USDC, amount, expiry] }),
      );
      const after = await pub.readContract({ abi: usdcAbi, address: USDC, functionName: "balanceOf", args: [vault] });
      if (after > before) rec.fundings++;
      return after - before;
    };

    const sign = async (value: bigint, nonceLabel: string, validBefore: bigint) => {
      const nonce = stringToHex(nonceLabel, { size: 32 });
      const structHash = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bytes32" },
          ],
          [TWA_TYPEHASH, vault, payee, value, 0n, validBefore, nonce],
        ),
      );
      const domain = await pub.readContract({ abi: usdcAbi, address: USDC, functionName: "DOMAIN_SEPARATOR" });
      const digest = await pub.readContract({
        abi: GranteeVaultAbi,
        address: vault,
        functionName: "granteeDigest",
        args: [domain, structHash],
      });
      const granteeSignature = await agentAcct.sign({ hash: digest });
      const signature = encodeAbiParameters(
        [
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
        ],
        [{ grantId, to: payee, value, validAfter: 0n, validBefore, nonce, granteeSignature }],
      );
      const callData = encodeFunctionData({
        abi: usdcAbi,
        functionName: "transferWithAuthorization",
        args: [vault, payee, value, 0n, validBefore, nonce, signature],
      });
      return { value, nonce, callData };
    };
    type Auth = Awaited<ReturnType<typeof sign>>;

    const settle = async (lbl: string, a: Auth, expectExpiry: bigint | "not determinable") => {
      const r = await exec(facilitator, USDC, a.callData);
      settlements.push({
        label: `${label} ${lbl}`,
        tx: r.transactionHash,
        block: r.blockNumber,
        vault,
        account,
        payee,
        value: a.value,
        nonce: a.nonce,
        submitter: facilitator,
        grantId,
        expectExpiry,
      });
      return r;
    };

    const kill = async () => {
      await exec(owner, account, encodeFunctionData({ abi: NablaAccountV3Abi, functionName: "kill" }));
      rec.kills++;
    };
    const unkill = async () =>
      exec(owner, account, encodeFunctionData({ abi: NablaAccountV3Abi, functionName: "unkill" }));
    const sweep = async () =>
      exec(
        facilitator,
        account,
        encodeFunctionData({ abi: NablaAccountV3Abi, functionName: "sweepGranteeVault", args: [granteeKey, USDC] }),
      );

    return { rec, grantExpiry, reserve, sign, settle, kill, unkill, sweep };
  }

  async function grantIdOf(account: Address, key: Hex): Promise<Hex> {
    // The only GRANT_SET for this account, read back from the record's logs.
    const logs = await pub.getLogs({
      address: C.NablaRecord.address,
      event: parseAbi([
        "event RecordEntry(address indexed subject, bytes32 indexed kind, address indexed writer, bytes32 writerAuth, address counterparty, bytes32 counterpartyAuth, bytes32 policyHash, uint32 policyVersion, address asset, uint256 amount, bytes32 amountCommitment, bytes32 obligationRef, bytes32 source, uint64 time, uint64 seq)",
      ])[0],
      args: { subject: account, kind: keccak256(stringToHex("GRANT_SET")) },
      fromBlock: BigInt(FORK_BLOCK + 1),
    });
    if (logs.length !== 1) throw new Error(`expected one GRANT_SET, got ${logs.length} (key ${key})`);
    return logs[0]!.args.writerAuth!;
  }

  // (i) five pre-signed, redeemed late and out of order across two day boundaries.
  {
    const k = await setupCase("(i)", 1);
    const e = (await now()) + 3n * 86400n;
    await k.reserve(40_000_000n, e);
    const a = [
      await k.sign(10_000_000n, "i1", e),
      await k.sign(10_000_000n, "i2", e),
      await k.sign(8_000_000n, "i3", e),
      await k.sign(7_000_000n, "i4", e),
      await k.sign(5_000_000n, "i5", e),
    ];
    await warpBy(12n * 3600n);
    await k.settle("#3", a[2]!, e);
    await warpBy(86400n);
    await k.settle("#5", a[4]!, e);
    await k.settle("#1", a[0]!, e);
    await warpBy(86400n);
    await k.settle("#4", a[3]!, e);
    await warpTo(e - 1n);
    await k.settle("#2", a[1]!, e);
  }

  // (ii) one aggregate signed after seven metered calls of 1.3.
  {
    const k = await setupCase("(ii)", 2);
    const e = (await now()) + 86400n;
    await k.reserve(30_000_000n, e);
    await warpBy(35n * 60n);
    await k.settle("aggregate 9.1", await k.sign(9_100_000n, "ii-agg", e), e);
  }

  // (iv-a) E1 expires unsettled, swept; E2 funds; the E1-signed authorization settles out of E2.
  {
    const k = await setupCase("(iv-a)", 3);
    const e1 = (await now()) + 86400n;
    await k.reserve(20_000_000n, e1);
    const late = await k.sign(10_000_000n, "iv-late", k.grantExpiry);
    await warpTo(e1);
    await k.sweep();
    const e2 = (await now()) + 2n * 86400n;
    await k.reserve(20_000_000n, e2);
    await k.settle("E1-signed out of E2", late, e2);
  }

  // (iv-b) as (iv-a) without the sweep: E2 tops up 0, writes no PAY_AUTHORIZED, still extends the expiry.
  {
    const k = await setupCase("(iv-b)", 4);
    const e1 = (await now()) + 86400n;
    await k.reserve(20_000_000n, e1);
    const late = await k.sign(10_000_000n, "iv-late", k.grantExpiry);
    await warpTo(e1);
    const e2 = (await now()) + 2n * 86400n;
    const topUp = await k.reserve(20_000_000n, e2);
    if (topUp !== 0n) throw new Error("(iv-b) expected a zero top-up");
    await k.settle("E1-signed, expiry extended", late, e2);
  }

  // (v) kill → unkill → the same authorization settles. Then an upgrade to the same implementation.
  let upgraded: Scenario["upgraded"];
  {
    const k = await setupCase("(v)", 5);
    const e = (await now()) + 86400n;
    await k.reserve(30_000_000n, e);
    const a = await k.sign(10_000_000n, "v1", e);
    await k.kill();
    await k.unkill();
    await k.settle("kill->unkill->settle", a, e);
    const impl = C.NablaAccountV3.address;
    const r = await exec(
      k.rec.owner,
      k.rec.account,
      encodeFunctionData({ abi: NablaAccountV3Abi, functionName: "upgradeToAndCall", args: [impl, "0x"] }),
    );
    upgraded = { account: k.rec.account, tx: r.transactionHash, implementation: impl };
  }

  // Batch: two settlements from one vault in one tx (Multicall3). R-D2B-6 counts per log.
  {
    const k = await setupCase("(batch)", 6);
    const e = (await now()) + 86400n;
    await k.reserve(30_000_000n, e);
    const a1 = await k.sign(4_000_000n, "b1", e);
    const a2 = await k.sign(6_000_000n, "b2", e);
    const r = await exec(
      facilitator,
      MULTICALL3,
      encodeFunctionData({
        abi: multicallAbi,
        functionName: "aggregate3",
        args: [
          [
            { target: USDC, allowFailure: false, callData: a1.callData },
            { target: USDC, allowFailure: false, callData: a2.callData },
          ],
        ],
      }),
    );
    for (const [lbl, a] of [["b1", a1], ["b2", a2]] as const) {
      settlements.push({
        label: `(batch) ${lbl}`,
        tx: r.transactionHash,
        block: r.blockNumber,
        vault: k.rec.vault,
        account: k.rec.account,
        payee: k.rec.payee,
        value: a.value,
        nonce: a.nonce,
        submitter: facilitator,
        grantId: k.rec.grantId,
        expectExpiry: e,
      });
    }
  }

  // Same block: a settlement, then a re-fund with a new expiry after it. The read at N differs from N−1.
  {
    const k = await setupCase("(same-block)", 7);
    const e = (await now()) + 86400n;
    await k.reserve(30_000_000n, e);
    const a = await k.sign(10_000_000n, "sb1", e);
    const e2 = e + 3600n;
    await test.setAutomine(false);
    const hSettle = await send(facilitator, USDC, a.callData, { maxPriorityFeePerGas: 10n ** 9n, gas: 1_000_000n });
    const hRefund = await send(
      k.rec.agent,
      k.rec.account,
      encodeFunctionData({ abi: NablaAccountV3Abi, functionName: "reservePayment", args: [k.rec.grantId, USDC, 30_000_000n, e2] }),
      { maxPriorityFeePerGas: 1n, gas: 3_000_000n },
    );
    await test.mine({ blocks: 1 });
    await test.setAutomine(true);
    const rs = await mined(hSettle);
    const rr = await mined(hRefund);
    if (rs.blockNumber !== rr.blockNumber || rs.transactionIndex >= rr.transactionIndex) {
      throw new Error("(same-block) settlement and re-fund not ordered within one block");
    }
    k.rec.fundings++;
    settlements.push({
      label: "(same-block) settle then re-fund",
      tx: rs.transactionHash,
      block: rs.blockNumber,
      vault: k.rec.vault,
      account: k.rec.account,
      payee: k.rec.payee,
      value: a.value,
      nonce: a.nonce,
      submitter: facilitator,
      grantId: k.rec.grantId,
      expectExpiry: "not determinable",
    });
  }

  // Obligations: an EOA subject writes about itself (subject == msg.sender), so no adapter is needed.
  let obligation: ObligationRecord;
  {
    const subject = await actor(getAddress("0x0000000000000000000000000000000000000b11"));
    const lender = getAddress("0x0000000000000000000000000000000000001e4d");
    const kindHash = (n: string) => keccak256(stringToHex(n));
    const write = async (kind: string, amount: bigint, ref: Hex) =>
      exec(
        subject,
        C.NablaRecord.address,
        encodeFunctionData({
          abi: NablaRecordAbi,
          functionName: "write",
          args: [
            {
              subject,
              kind: kindHash(kind),
              writerAuth: pad("0x0", { size: 32 }),
              counterparty: lender,
              counterpartyAuth: pad("0x0", { size: 32 }),
              policyHash: pad("0x0", { size: 32 }),
              policyVersion: 0,
              asset: USDC,
              amount,
              amountCommitment: pad("0x0", { size: 32 }),
              obligationRef: ref,
              source: pad("0x0", { size: 32 }),
            },
          ],
        }),
      );
    const zero = pad("0x0", { size: 32 });
    const opened = await write("OBLIGATION_OPENED", 100_000_000n, zero);
    const ref = parseEventLogs({ abi: NablaRecordAbi, eventName: "RecordEntry", logs: opened.logs })[0]!.args.obligationRef;
    const repay = await write("REPAY", 40_000_000n, ref);
    const unlinked = await write("REPAY", 5_000_000n, zero);
    const closed = await write("OBLIGATION_CLOSED", 0n, ref);
    obligation = {
      subject,
      lender,
      ref,
      txs: [opened.transactionHash, repay.transactionHash, unlinked.transactionHash, closed.transactionHash],
    };
  }

  // eth_blockNumber directly: viem caches getBlockNumber.
  const endBlock = Number(await pub.request({ method: "eth_blockNumber" }));
  // Ponder treats blocks within 180 s of head as unfinalized; one later block puts the scenario behind it.
  await warpBy(3600n);
  await test.mine({ blocks: 1 });
  return { cases, settlements, obligation, upgraded, endBlock };
}
