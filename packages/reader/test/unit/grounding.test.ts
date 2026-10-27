// R-D2B-2 feedback grounding, as corrected by R-S191-11 (any ERC-20 Transfer from the rater; the label is
// separate) and R-S191-16 (the payment address at the payment block: agentWallet, else owner; never a later
// block; no identity at that block → not grounded), with the wallet at the feedback block reported beside it
// (R-S191-12), and R-S190-3 (c) share. Rows in, facts out; the binding reads run against a recording client.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { LABEL } from "../../src/labels";
import { DIRECT_TRANSFER, IDENTITY_DID_NOT_EXIST, cShare, groundingFact, groundingTransfers, type Binding, type Fact, type GroundingInput, type LabelledPayment, type RaterTransfer } from "../../src/read";
import { bindingsAtTransferBlocks } from "../../src/grounding-rpc";

const WALLET: Address = getAddress("0x00000000000000000000000000000000000b0001");
const LATER_WALLET: Address = getAddress("0x00000000000000000000000000000000000b0002");
const RATER: Address = getAddress("0x00000000000000000000000000000000000c0001");
const OTHER: Address = getAddress("0x00000000000000000000000000000000000d0001");
const TOKEN: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TX: Hex = `0x${"ab".repeat(32)}`;
const PAY_TX: Hex = `0x${"cd".repeat(32)}`;

// A feedbacks row as the database could hold it, plus the fields the reader must never output.
const FEEDBACK = {
  chainId: 8453,
  blockNumber: 100n,
  txHash: TX,
  logIndex: 7,
  reproduce: "cast logs …",
  agentId: 42n,
  client: RATER,
  feedbackIndex: 3n,
  value: 9137n,
  valueDecimals: 2,
  tag1: "zz-leak-tag-one",
  tag2: "zz-leak-tag-two",
  feedbackURI: "https://zz-leak.example/feedback.json",
};

const transfer = (block: bigint, logIndex: number, to: Address = WALLET, from: Address = RATER): RaterTransfer => ({ chainId: 8453, token: TOKEN, from, to, amount: 10_000n, block, tx: PAY_TX, logIndex });
const OWNER: Address = getAddress("0x00000000000000000000000000000000000e0001");
/**
 * The binding by block: no identity before block 30; agentWallet WALLET up to 80; cleared from 81, so the owner
 * OWNER is the payment address; agentWallet LATER_WALLET from 95.
 */
const bindingAt = (b: bigint): Binding =>
  b < 30n ? { kind: "none" } : b <= 80n ? { kind: "agentWallet", address: WALLET } : b >= 95n ? { kind: "agentWallet", address: LATER_WALLET } : { kind: "owner", address: OWNER };
const spm: LabelledPayment = {
  fact: { source: "coinbase:spend_permission_payment", label: "(a) allowance, per period", shape: "a", terms: { payer: RATER, payee: WALLET, token: TOKEN, amount: "10000" }, cite: { chainId: 8453, block: "50", tx: PAY_TX, logIndex: 3 }, reproduce: "cast …" },
  tx: PAY_TX,
  transferLogIndex: 2,
};

const base: GroundingInput = {
  subject: WALLET,
  feedback: FEEDBACK,
  payments: { payments: [], preIdentity: [] },
  transfersRange: { from: 1, to: 100n },
  walletAtFeedback: WALLET,
  raterController: null,
  subjectController: null,
};
const g = (over: Partial<GroundingInput>) => groundingFact({ ...base, ...over });
const ground = (ts: RaterTransfer[], labelled: LabelledPayment[] = [], over: Partial<GroundingInput> = {}) => g({ payments: groundingTransfers(ts, bindingAt, labelled), ...over });
const terms = (f: Fact) => f.terms as Record<string, any>;

describe("R-S191-11: any ERC-20 Transfer from the rater grounds; the label is a separate question", () => {
  it("a plain transfer with no permission object grounds, labelled (c) direct transfer", () => {
    const f = ground([transfer(50n, 2)]);
    expect(terms(f).grounding).toBe("grounded");
    expect(terms(f).payment).toMatchObject({ source: "erc20:transfer", shape: "c", label: LABEL.c, payer: RATER, boundAtPayment: WALLET });
    expect(terms(f).binding).toBe("agentWallet");
    expect(terms(f).payment.terms.reason).toBe(DIRECT_TRANSFER);
    expect(terms(f).payment.cite).toEqual({ chainId: 8453, block: "50", tx: PAY_TX, logIndex: 2 });
  });
  it("a transfer that is a payment fact keeps that fact's label", () => {
    const f = ground([transfer(50n, 2)], [spm]);
    expect(terms(f).payment).toMatchObject({ source: "coinbase:spend_permission_payment", label: "(a) allowance, per period", shape: "a" });
  });
  it("the most recent prior transfer is cited; transfers from anyone else do not count", () => {
    const f = ground([transfer(40n, 1), transfer(60n, 9), transfer(60n, 4, WALLET, OTHER)]);
    expect(terms(f).payment.cite.logIndex).toBe(9);
    expect(terms(ground([transfer(60n, 4, WALLET, OTHER)])).grounding).toBe("not grounded");
  });
});

describe("R-S191-16: the payment address is resolved at the payment block, agentWallet else owner", () => {
  it("a payment to the agentWallet of its block grounds, even when the wallet is cleared at the feedback block", () => {
    const f = ground([transfer(50n, 2)], [], { walletAtFeedback: null });
    expect(terms(f)).toMatchObject({ grounding: "grounded", binding: "agentWallet", walletAtFeedback: "wallet at feedback: cleared" });
  });
  it("with no agentWallet at the payment block, a payment to the owner grounds, binding owner", () => {
    const f = ground([transfer(85n, 2, OWNER)], [], { walletAtFeedback: null });
    expect(terms(f)).toMatchObject({ grounding: "grounded", binding: "owner, no agentWallet" });
    expect(terms(f).payment.boundAtPayment).toBe(OWNER);
  });
  it("a payment to an address bound only later does not ground (never resolved at a later block)", () => {
    // LATER_WALLET is the agentWallet from block 95 on, and the payment address at the feedback (100).
    const f = ground([transfer(60n, 2, LATER_WALLET), transfer(85n, 1, LATER_WALLET)], [], { walletAtFeedback: LATER_WALLET, subject: LATER_WALLET });
    expect(terms(f).grounding).toBe("not grounded");
    expect(terms(f).walletAtFeedback).toBe(`wallet at feedback: ${LATER_WALLET}`);
  });
  it("a payment made before the identity existed does not ground: identity did not exist at the payment block", () => {
    const f = ground([transfer(20n, 2), transfer(25n, 1, OWNER)], [], { walletAtFeedback: WALLET });
    expect(terms(f)).toMatchObject({ grounding: "not grounded", reason: IDENTITY_DID_NOT_EXIST });
    expect(terms(ground([transfer(20n, 2), transfer(50n, 1)])).grounding).toBe("grounded");
  });
  it("the binding reads go to exactly each candidate transfer's block, never a later one", async () => {
    const calls: { fn: string; block: bigint }[] = [];
    const client = {
      readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
        calls.push({ fn: functionName, block: blockNumber });
        if (functionName === "getAgentWallet") return blockNumber <= 80n ? WALLET : "0x0000000000000000000000000000000000000000";
        return OWNER;
      },
    } as never;
    const ts = [transfer(50n, 2), transfer(85n, 1, OWNER), transfer(90n, 1, OTHER)];
    const lookup = await bindingsAtTransferBlocks(client, OTHER, 42n, ts, new Set([WALLET.toLowerCase(), OWNER.toLowerCase()]));
    expect(new Set(calls.map((c) => c.block))).toEqual(new Set([50n, 85n]));
    expect(lookup(50n)).toEqual({ kind: "agentWallet", address: WALLET });
    expect(lookup(85n)).toEqual({ kind: "owner", address: OWNER });
    expect(lookup(90n)).toBeUndefined();
  });
  it("no payment address at any payment block: not grounded, not not determinable", () => {
    const f = ground([transfer(85n, 2), transfer(90n, 1)], [], { walletAtFeedback: null });
    expect(terms(f)).toMatchObject({ grounding: "not grounded", reason: "no ERC-20 Transfer from the rater to the address bound at its block (agentWallet, else owner), before the feedback (blocks 1..100)" });
  });
});

describe("grounding: order, ranges and reads", () => {
  it("same block: log order decides; a transfer logged after the feedback does not ground", () => {
    expect(terms(ground([transfer(100n, 6, LATER_WALLET)], [], { subject: LATER_WALLET })).grounding).toBe("grounded");
    expect(terms(ground([transfer(100n, 8, LATER_WALLET)], [], { subject: LATER_WALLET })).grounding).toBe("not grounded");
  });
  it("same block without a log order is not determinable: same block", () => {
    expect(terms(ground([transfer(100n, Number.NaN, LATER_WALLET)]))).toMatchObject({ grounding: "not determinable", reason: "same block" });
  });
  it("not determinable only for reads the reader cannot make", () => {
    expect(terms(g({ payments: { error: "query timeout" } }))).toMatchObject({ grounding: "not determinable" });
    expect(terms(g({ payments: { error: "query timeout" } })).reason).toMatch(/^the rater's transfers in blocks 1\.\.100 could not be read/);
    expect(terms(g({ transfersRange: { from: 150, to: 100n } }))).toMatchObject({ grounding: "not determinable", reason: "transfers indexed up to 100; source starts at 150" });
    expect(terms(g({ walletAtFeedback: { error: "missing trie node" } })).walletAtFeedback).toMatch(/^wallet at feedback: not determinable/);
  });
  it("the fact is the rater's attestation (e), cites the feedback log, states the range read, and says the feedbackURI is not read", () => {
    const f = g({});
    expect(f).toMatchObject({ source: "erc8004:feedback_grounding", shape: "e", label: `${LABEL.e}: ${RATER}`, cite: { chainId: 8453, block: "100", tx: TX, logIndex: 7 } });
    expect(terms(f)).toMatchObject({ transfersRead: "blocks 1..100", nativeTransfers: "not read", walletAtFeedback: `wallet at feedback: ${WALLET}`, feedbackURI: "not read" });
  });
  it("writer == subject and the controller comparison (R-S189-4)", () => {
    expect(terms(g({})).raterIsSubject).toBe(false);
    expect(terms(g({ feedback: { ...FEEDBACK, client: WALLET } })).raterIsSubject).toBe(true);
    expect(terms(g({})).sameController).toMatch(/^not determinable/);
    const ctl = (c: Address) => ({ controller: c, from: "AccountCreated" as const });
    expect(terms(g({ raterController: ctl(OTHER), subjectController: ctl(OTHER) })).sameController).toBe(true);
    expect(terms(g({ raterController: ctl(OTHER), subjectController: ctl(RATER) })).sameController).toBe(false);
    expect(terms(g({ raterController: { controller: null, reason: "x" }, subjectController: ctl(RATER) })).sameController).toMatch(/^not determinable/);
  });
  it("never outputs the feedback's value, valueDecimals, tags or URIs", () => {
    for (const f of [g({}), ground([transfer(50n, 2)]), g({ payments: { error: "x" } })]) {
      const own = Object.keys(f.terms);
      for (const k of ["value", "valueDecimals", "tag1", "tag2", "endpoint", "feedbackHash"]) expect(own).not.toContain(k);
      const out = JSON.stringify(f, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      for (const leak of ["9137", "zz-leak-tag-one", "zz-leak-tag-two", "zz-leak.example"]) expect(out).not.toContain(leak);
    }
  });
  it("the feedbacks table has no column for the value, decimals, tags or URIs", () => {
    const schema = readFileSync(new URL("../../ponder.schema.ts", import.meta.url), "utf8");
    const table = schema.slice(schema.indexOf('"feedbacks"'), schema.indexOf("export const agentWallets"));
    for (const col of ["value:", "valueDecimals", "tag1", "tag2", "endpoint", "feedbackURI:", "feedbackHash:"]) expect(table).not.toContain(col);
  });
});

describe("(c) share (R-S190-3)", () => {
  const fact = (source: string, shape: string, token: Address, amount: string, key = "amount"): Fact => ({
    source,
    shape,
    label: shape,
    terms: { token, [key]: amount },
    cite: { chainId: 8453, block: "1", tx: TX, logIndex: 0 },
    reproduce: "",
  });
  it("per token, count and value of (c) payment facts over all payment facts; never summed across tokens", () => {
    const r = cShare([
      fact("coinbase:spend_permission_payment", "a", TOKEN, "100"),
      fact("metamask:delegation_payment", "c", TOKEN, "30"),
      fact("nablaz:vault_payment", "c", OTHER, "5", "value"),
      fact("metamask:redemption", "c", TOKEN, "999"),
      fact("erc8004:feedback_grounding", "e", TOKEN, "999"),
    ]);
    expect(r).toEqual({
      [getAddress(TOKEN)]: { count: { c: 1, total: 2 }, value: { c: "30", total: "130" } },
      [getAddress(OTHER)]: { count: { c: 1, total: 1 }, value: { c: "5", total: "5" } },
    });
  });
});
