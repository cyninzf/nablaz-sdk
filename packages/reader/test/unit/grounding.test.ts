// R-D2B-2 feedback grounding (AFG definition: a payment from the rater to the rated agentWallet settled before
// the feedback), and R-S190-3 (c) share. Pure: rows in, facts out.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { LABEL } from "../../src/labels";
import { cShare, groundingFact, type Fact, type GroundingInput, type GroundingPayment } from "../../src/read";

const WALLET: Address = "0x00000000000000000000000000000000000B0001";
const RATER: Address = "0x00000000000000000000000000000000000C0001";
const OTHER: Address = "0x00000000000000000000000000000000000D0001";
const TOKEN: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TX: Hex = `0x${"ab".repeat(32)}`;

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

const pay = (block: bigint, logIndex: number, over: Partial<GroundingPayment> = {}, shape = "a"): GroundingPayment => ({
  fact: {
    source: "coinbase:spend_permission_payment",
    label: shape === "c" ? LABEL.c : "(a) allowance, per period",
    shape,
    terms: { payer: RATER, payee: WALLET, token: TOKEN, amount: "10000" },
    cite: { chainId: 8453, block: String(block), tx: TX, logIndex },
    reproduce: "cast …",
  },
  payer: RATER,
  payee: WALLET,
  block,
  logIndex,
  ...over,
});

const base: GroundingInput = {
  subject: WALLET,
  feedback: FEEDBACK,
  wallet: { before: WALLET, at: WALLET },
  payments: [],
  paymentsFrom: 1,
  raterController: null,
  subjectController: null,
};
const g = (over: Partial<GroundingInput>) => groundingFact({ ...base, ...over })!;
const terms = (f: Fact) => f.terms as Record<string, any>;

describe("grounding", () => {
  it("a payment from the rater to the agentWallet in an earlier block grounds it; the most recent one is cited, with its own label", () => {
    const f = g({ payments: [pay(50n, 1), pay(90n, 4), pay(120n, 0)] });
    expect(terms(f).grounding).toBe("grounded");
    expect(terms(f).payment.cite).toEqual({ chainId: 8453, block: "90", tx: TX, logIndex: 4 });
    expect(terms(f).payment.label).toBe("(a) allowance, per period");
    expect(terms(f).payment.payer).toBe(RATER);
  });
  it("same block: log order decides; a payment logged after the feedback does not ground it", () => {
    expect(terms(g({ payments: [pay(100n, 6)] })).grounding).toBe("grounded");
    expect(terms(g({ payments: [pay(100n, 8)] }))).toMatchObject({ grounding: "not grounded" });
  });
  it("same block without a log order is not determinable: same block", () => {
    expect(terms(g({ payments: [pay(100n, Number.NaN)] }))).toMatchObject({ grounding: "not determinable", reason: "same block" });
  });
  it("only rater → agentWallet payments count", () => {
    const f = g({ payments: [pay(50n, 1, { payer: OTHER }), pay(50n, 2, { payee: OTHER })] });
    expect(terms(f)).toMatchObject({ grounding: "not grounded", reason: "nothing indexed from the rater to this wallet before the feedback (blocks 1..100)" });
  });
  it("payment sources indexed only after the feedback, or not at all: not determinable", () => {
    expect(terms(g({ paymentsFrom: 150 }))).toMatchObject({ grounding: "not determinable", reason: "payment sources are indexed from block 150, after the feedback" });
    expect(terms(g({ paymentsFrom: null }))).toMatchObject({ grounding: "not determinable" });
  });
  it("the agentWallet is read at the feedback block and the block before; a change within the block is not determinable", () => {
    expect(terms(g({ wallet: { before: OTHER, at: WALLET }, payments: [pay(50n, 1)] }))).toMatchObject({ grounding: "not determinable", reason: "agentWallet changed within the feedback block" });
    expect(terms(g({ wallet: { before: null, at: null } }))).toMatchObject({ grounding: "not determinable" });
    expect(terms(g({ wallet: { error: "missing trie node" } })).reason).toMatch(/getAgentWallet at blocks 99 and 100 could not be read/);
  });
  it("a feedback whose agentWallet at the feedback block is another address is not about the subject", () => {
    expect(groundingFact({ ...base, wallet: { before: OTHER, at: OTHER } })).toBeNull();
  });
  it("the fact is the rater's attestation (e), cites the feedback log, and says the feedbackURI is not read", () => {
    const f = g({});
    expect(f).toMatchObject({ source: "erc8004:feedback_grounding", shape: "e", label: `${LABEL.e}: ${RATER}`, cite: { chainId: 8453, block: "100", tx: TX, logIndex: 7 } });
    expect(terms(f).feedbackURI).toBe("not read");
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
    for (const f of [g({}), g({ payments: [pay(50n, 1)] }), g({ wallet: { error: "x" } })]) {
      const out = JSON.stringify(f, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      for (const k of ["value", "valueDecimals", "tag1", "tag2", "feedbackURI\":\"https", "endpoint", "feedbackHash"]) expect(out).not.toContain(`"${k}"`);
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
