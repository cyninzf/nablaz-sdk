// The S186 mainnet runbook's Block A and Block C calldata, read out of the runbook itself and sent as-is by
// the holder on a fork: what the operator signs is what this proves.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseEventLogs, stringToHex, type Address, type Hex } from "viem";
import { arbitrum } from "viem/chains";
import { ConsumerAIMandateV4Abi, NablaAccountV3_1Abi, NablaRecordAbi } from "../../src/generated/abis.ts";
import { ARBITRUM_ONE } from "../../src/index.ts";
import { FORK_BLOCK, startAnvil, type Anvil } from "./anvil.ts";

const RUNBOOK = new URL("../../../../docs/runbooks/s186-b2-phase0-mainnet.md", import.meta.url);
const TEST: Address = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
const HOLDER: Address = "0x8A6cec15736F3072Db75514815F7470f64dF0100";
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_WHALE: Address = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
const HOT_KEY: Address = "0xCc885831ef9B284E7D5F199A6f4f72D290CC0243";
const GRANT_ID: Hex = "0xefc5e61448596750c570eac19e80354a2671c1ae063b963ed1db28fa3ab4be8f";
const GRANTEE_KEY: Hex = "0x2c2ed5dd86fb43ad5766dcfa4e33aaf46c79270badcd0d3a429c08741b69c8fa";
const VAULT: Address = "0x46414CFb3F27735F2a9824abfb63699bF80ed001";
const EXPIRY = 1_793_491_200n; // 2026-11-01 00:00:00 UTC
const CAM = ARBITRUM_ONE.contracts.ConsumerAIMandateV4.address;
const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);

/** The calldata block that follows `heading` in the runbook. */
function calldataAfter(md: string, heading: string, selector: string): Hex {
  const at = md.indexOf(heading);
  const m = md.slice(at).match(new RegExp(`\\n(${selector}[0-9a-f]+)\\n`));
  if (at < 0 || !m) throw new Error(`no ${selector} calldata after "${heading}"`);
  return m[1] as Hex;
}

let anvil: Anvil;
beforeAll(async () => {
  anvil = await startAnvil(FORK_BLOCK);
}, 120_000);
afterAll(async () => anvil?.stop());

it("Block A then Block C, byte for byte, land the grant, the envelope and the vault the runbook predicts", async () => {
  const md = readFileSync(RUNBOOK, "utf8");
  const blockA = calldataAfter(md, "## Block A", "0x75b562de");
  const blockC = calldataAfter(md, "## Block C", "0x6dbcfed9");
  const transport = http(anvil.url);
  const pub = createPublicClient({ chain: arbitrum, transport });
  const test = createTestClient({ chain: arbitrum, mode: "anvil", transport });
  const wallet = createWalletClient({ chain: arbitrum, transport });
  for (const a of [HOLDER, USDC_WHALE]) {
    await test.impersonateAccount({ address: a });
    await test.setBalance({ address: a, value: 10n ** 21n });
  }
  const send = async (from: Address, to: Address, data: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: from, to, data, chain: arbitrum }) });
    expect(r.status).toBe("success");
    return r;
  };

  // Step 0 checks.
  expect(await pub.readContract({ address: CAM, abi: ConsumerAIMandateV4Abi, functionName: "grantNonce", args: [TEST] })).toBe(0n);
  expect(await pub.readContract({ address: TEST, abi: NablaAccountV3_1Abi, functionName: "controller" })).toBe(HOLDER);

  const a = await send(HOLDER, TEST, blockA);
  const [grantSet] = parseEventLogs({ abi: NablaRecordAbi, eventName: "RecordEntry", logs: a.logs });
  expect(grantSet!.args).toMatchObject({ subject: TEST, kind: keccak256(stringToHex("GRANT_SET")), writerAuth: GRANT_ID, counterparty: HOT_KEY });
  const g = await pub.readContract({ address: CAM, abi: ConsumerAIMandateV4Abi, functionName: "grantOf", args: [TEST, GRANT_ID] });
  expect(g).toMatchObject({ grantee: HOT_KEY, agentId: 0n, granteeKey: GRANTEE_KEY, expiry: EXPIRY, version: 1, revoked: false, killed: false });
  expect(g.allowances[0]!.allowance).toMatchObject({ tokenAddress: USDC, periodAmount: 2_000_000n, periodDuration: 0, startTime: 1_792_800_000n, perTx: 1_000_000n });
  expect(await pub.readContract({ address: CAM, abi: ConsumerAIMandateV4Abi, functionName: "granteeOf", args: [TEST, GRANT_ID] })).toEqual([HOT_KEY, GRANTEE_KEY]);

  // Block B: 2.00 USDC to the TEST account.
  await send(USDC_WHALE, USDC, encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [TEST, 2_000_000n] }));

  const c = await send(HOLDER, TEST, blockC);
  const [payAuthorized] = parseEventLogs({ abi: NablaRecordAbi, eventName: "RecordEntry", logs: c.logs });
  expect(payAuthorized!.args).toMatchObject({ kind: keccak256(stringToHex("PAY_AUTHORIZED")), writerAuth: GRANT_ID, counterparty: HOT_KEY, asset: USDC, amount: 2_000_000n });
  expect(getAddress(`0x${payAuthorized!.args.counterpartyAuth.slice(-40)}`)).toBe(VAULT);
  expect(await pub.readContract({ address: TEST, abi: NablaAccountV3_1Abi, functionName: "granteeVault", args: [GRANTEE_KEY] })).toBe(VAULT);
  expect(await pub.readContract({ address: CAM, abi: ConsumerAIMandateV4Abi, functionName: "envelopeOf", args: [TEST, GRANTEE_KEY, USDC] })).toEqual([GRANT_ID, EXPIRY]);
  expect(await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [VAULT] })).toBe(2_000_000n);
  expect(await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [TEST] })).toBe(0n);
});
