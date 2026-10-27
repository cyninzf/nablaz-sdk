// Shape and label for every fixture (R-S189-3 AMENDED 2 and 3, R-S189-5, R-S189-6, R-S189-7).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  concat,
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  pad,
  parseAbiParameters,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  ANY_DELEGATE,
  ROOT_AUTHORITY,
  decodeRedeemedDelegation,
  delegationHash,
  erc20TransfersFrom,
  hopOf,
  type Caveat,
} from "../../src/delegation";
import { AgentCreditLineAbi, SpendPermissionManagerAbi } from "../../src/external-abis";
import { LABEL, attestationLabel, canonicalLineage, nablaLabel, renderB, shapeOfDelegation, shapeOfSpm, type SpendPermission } from "../../src/labels";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

// ── Enforcer addresses (src/generated/enforcers.json) ──
const E = {
  LimitedCalls: "0x04658B29F6b82ed55274221a06Fc97D318E25416",
  ExactExecution: "0x146713078D39eCC1F5338309c28405ccf85Abfbb",
  Redeemer: "0xE144b0b2618071B4E56f746313528a669c7E65c5",
  ERC20PeriodTransfer: "0x474e3Ae7E169e940607cC624Da8A15Eb120139aB",
  ERC20TransferAmount: "0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc",
  ERC20BalanceChange: "0xcdF6aB796408598Cea671d79506d7D48E97a5437",
  AllowedTargets: "0x7F20f61b1f09b08D970938F6fa563634d65c4EeB",
  NativeTokenPayment: "0x4803a326ddED6dDBc60e659e5ed12d85c7582811",
  LogicalOrWrapper: "0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c",
  SpecificActionOld: "0x00e0251aaA263dfE3B3541B758A82D1CBA1c3B6D",
  ApprovalRevocation: "0xe264F1f09A19505a1ca1a86D5b01E8bFdb64324A",
  ERC20MultiOpIncrease: "0xeaA1bE91F0ea417820a765df9C5BE542286BFfDC",
} as const satisfies Record<string, Address>;
const UNKNOWN: Address = "0x29fcBBa852439616c4D614A2fa6411E42b760153";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ALICE: Address = "0x1111111111111111111111111111111111111111";

const u256 = (n: bigint | number) => pad(toHex(n), { size: 32 });
const cv = (enforcer: Address, terms: Hex = "0x"): Caveat => ({ enforcer, terms, args: "0x" });
const limited = (n: number) => cv(E.LimitedCalls, u256(n));
const exact = () => cv(E.ExactExecution, concat([USDC, u256(0), "0xa9059cbb", pad(ALICE), u256(5)]));
const period = () => cv(E.ERC20PeriodTransfer, concat([USDC, u256(1_000_000), u256(86_400), u256(1)]));
const balanceChange = (decrease: boolean) => cv(E.ERC20BalanceChange, concat([decrease ? "0x01" : "0x00", USDC, ALICE, u256(10)]));
const wrapper = (groups: Caveat[][]) =>
  cv(
    E.LogicalOrWrapper,
    encodeAbiParameters(parseAbiParameters("((address enforcer, bytes terms, bytes args)[] caveats)[]"), [groups.map((g) => ({ caveats: g }))]),
  );

// ── On-chain fixtures (P0-3; Base multi-hop; worked (c) example) ──

const ONCE = LABEL.bOnce;
const EXPECTED: Record<string, { label: string; hop: "root" | "child"; transfers: number }> = {
  "42161-0xe6dd7f54c89a1b70c802d4456fa0a2a0e9a8ffef74e3fd8244c6edb6dbbc1478-3": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0xab20e32de61fc21a21eb9dfe57f2b17b32746e2d676f59f76cbea17c511e94aa-20": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0xdd34cb012aacf38320894bc3ed38ee27bf35ef1de292d5cfa9b86fd8f8cebd73-6": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0x9dfe64c035638a82ac420df80b5d850694e88c68eabb26d357e2d18038b776c6-4": { label: "(a) allowance, per execution", hop: "root", transfers: 0 },
  "42161-0x57a7d9b807292fa56976763aabcde30e0b97c414b44806d4f729c1d472436479-15": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0x9c38d30ac358c627c922a8f40ecf661f05cb3b6a571b1b7cad352e435cf86e43-9": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0xffc1006c54adce8526816e6673297719e8f047d8b956c3306ff09f447937da39-5": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0xec9c7fb6f5d47cdaae7cacdab0c795e8c004350e1e2062c4078808fa6320bd19-8": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0xeb4582e7bb0d55a45cc704c8ba86f8bb066cbc045901a7ab282b00c11cff8614-7": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0x8fc88f69586f6f6853f03c6eea674cf8abba27d9590d807c7b72428dd40c5906-2": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0xc7cca23a01e0d5082872409e0445b535309e4cc06546e0290f34bcc21031285a-8": { label: ONCE, hop: "root", transfers: 1 },
  "42161-0xe75b7e7146ea4da3c93e662c8214120191b15576a7c7a8efdcae74625be92cf9-7": { label: ONCE, hop: "root", transfers: 2 },
  "8453-0x7a940f6d9bd84edd5d5909b829096d2d7b6f94d2da9a54520e1e7923a54ed063-237": { label: ONCE, hop: "root", transfers: 1 },
  "8453-0x219d9d6572b34d525f3c142e605baa302c34689e17a22a23c072ff89c0459782-311": { label: ONCE, hop: "root", transfers: 2 },
  "8453-0xe25d05788d4c05fcf500a84b60298e2ee2de99981fa6a7447254da8b48de41da-469": { label: ONCE, hop: "root", transfers: 2 },
  "8453-0x93774af1f00d8a2f4d7511589f4147c2628f088bc38dd5520c1f3065ebb55dc2-660": { label: ONCE, hop: "root", transfers: 3 },
  "8453-0x19c3dfe9edf7eae156f26c936a059a535bcac1e8625c7195229b3927754e8e84-113": { label: ONCE, hop: "root", transfers: 1 },
  "8453-0x9f839882543833cdb31a4caf7114fbc7776294e28702ce7ad7920f9e00d38e84-289": { label: ONCE, hop: "root", transfers: 2 },
  "8453-0x8933f1ed90df4969103392bf84e14d47c99f979edc3197e7f0c424c1fcc2e643-747": { label: ONCE, hop: "root", transfers: 1 },
  "8453-0xf1a66ed187c2792b26ac5519831dd225bef2773731a78b8d7c18a7d6f80cf26f-118": { label: ONCE, hop: "root", transfers: 1 },
  "8453-0x7e9887131cc9db2e54061dbc88e83d11db41b6c6919950ad0da81ef426d20068-229": { label: ONCE, hop: "root", transfers: 1 },
  "8453-0x6f4596d1c1ba8f8928b576fb07ed9350f86b18d3b8d61d724162b2fecdcb44e9-439": { label: ONCE, hop: "root", transfers: 1 },
  "8453-0x5665950ff828dc79a6a7ab52f0203f48f360b6438de181b8ec51e71f7bcd1b46-652": { label: ONCE, hop: "root", transfers: 1 },
  "8453-0xde725607cea8edb0cffc561a5ed908986e1e0a4849523355c2e2b5db79135e71-274": { label: ONCE, hop: "root", transfers: 3 },
  // Base multi-hop: leaf (log 352) then root (log 353); the Transfer is from the root delegator.
  "8453-0xcc399fad3554f9c7e42f465124c8114b42a420140647b178c03ae3217a22562e-352": { label: "(a) allowance, total, per call", hop: "child", transfers: 0 },
  "8453-0xcc399fad3554f9c7e42f465124c8114b42a420140647b178c03ae3217a22562e-353": { label: "(a) allowance, per period, per call", hop: "root", transfers: 1 },
  // Worked (c) example: 0x29fcBBa8…0153 is in no vendor list.
  "8453-0xe2f861045f44fd86e15ca9d39656c1a8a714570bcd8214efd896a9d76bc9773a-516": { label: LABEL.c, hop: "root", transfers: 2 },
};

describe("on-chain delegation fixtures", () => {
  const { delegations } = fixture("delegations.json");

  it("covers ≥12 redemptions, both chains", () => {
    expect(delegations.length).toBeGreaterThanOrEqual(12);
    expect(new Set(delegations.map((d: any) => d.chainId))).toEqual(new Set([42161, 8453]));
    expect(delegations).toHaveLength(Object.keys(EXPECTED).length);
  });

  for (const d of fixture("delegations.json").delegations) {
    const key = `${d.chainId}-${d.tx}-${d.log.logIndex}`;
    it(`${key}: shape, label, hop, same-tx payments`, () => {
      const want = EXPECTED[key]!;
      const r = decodeRedeemedDelegation(d.log);
      const s = shapeOfDelegation(r.delegation.caveats);
      expect(s.label).toBe(want.label);
      expect(hopOf(r.delegation)).toBe(want.hop);
      // R-S189-5: only a Transfer from this hop's delegator in the same tx is a payment.
      expect(erc20TransfersFrom(d.txLogs, [r.delegation.delegator])).toHaveLength(want.transfers);
      // Never a word about who the payer is.
      expect(s.label.toLowerCase()).not.toMatch(/\bagent/);
    });
  }

  it("multi-hop: one event per hop, leaf first, topic1 = root delegator, leaf authority = hash(root)", () => {
    const hops = delegations
      .filter((d: any) => d.tx === "0xcc399fad3554f9c7e42f465124c8114b42a420140647b178c03ae3217a22562e")
      .sort((a: any, b: any) => a.log.logIndex - b.log.logIndex)
      .map((d: any) => decodeRedeemedDelegation(d.log));
    expect(hops).toHaveLength(2);
    const [leaf, root] = hops;
    expect(root.delegation.authority).toBe(ROOT_AUTHORITY);
    expect(leaf.delegation.authority.toLowerCase()).toBe(delegationHash(root.delegation));
    expect(leaf.rootDelegator).toBe(root.delegation.delegator);
    expect(root.rootDelegator).toBe(root.delegation.delegator);
  });

  it("open delegations use ANY_DELEGATE, not address(0)", () => {
    const delegates = delegations.map((d: any) => decodeRedeemedDelegation(d.log).delegation.delegate.toLowerCase());
    expect(delegates).toContain(ANY_DELEGATE);
    expect(delegates).not.toContain("0x0000000000000000000000000000000000000000");
  });
});

// ── Synthetic delegations: every precedence branch ──

describe("R-S189-3 AMENDED 2 precedence and AMENDED 3 rendering", () => {
  const label = (cs: Caveat[]) => shapeOfDelegation(cs).label;

  it("open delegation with only RedeemerEnforcer → (d)", () => {
    expect(label([cv(E.Redeemer, ALICE)])).toBe(LABEL.d);
  });
  it("renders (b) as once / N times / count unbounded", () => {
    expect(renderB(1n)).toBe("(b) exact execution, once");
    expect(renderB(3n)).toBe("(b) exact execution, 3 times");
    expect(renderB("unbounded")).toBe("(b) exact execution, count unbounded");
    expect(label([exact(), limited(1)])).toBe("(b) exact execution, once");
    expect(label([exact(), limited(3)])).toBe("(b) exact execution, 3 times");
    expect(label([exact()])).toBe("(b) exact execution, count unbounded");
  });
  it("SpecificActionERC20TransferBatch is single-use: N = 1 even with a higher LimitedCalls", () => {
    const sa = cv(E.SpecificActionOld, concat([USDC, ALICE, u256(5), ALICE]));
    expect(label([sa, limited(5)])).toBe(LABEL.bOnce);
    expect(shapeOfDelegation([sa]).enforcers[0]!.superseded).toBe("superseded by vendor at b4b8c41f");
  });
  it("ApprovalRevocationEnforcer alone renders its own (b) label (R-S189-7)", () => {
    expect(label([cv(E.ApprovalRevocation, "0x01")])).toBe("(b) exact execution: approval revocation, no value");
    expect(label([cv(E.ApprovalRevocation, "0x01"), exact()])).toBe(LABEL.bUnbounded);
  });
  it("(1) unknown beats (2) exact-call", () => {
    expect(label([cv(UNKNOWN), exact(), limited(1)])).toBe(LABEL.c);
  });
  it("(2) exact-call beats (3) amount", () => {
    expect(label([exact(), period()])).toBe("(b) exact execution, count unbounded");
  });
  it("(3) several amount enforcers: bases in a fixed order, whatever the caveat order", () => {
    const valueLte = cv("0x92Bf12322527cAA612fd31a0e810472BBB106A8F", u256(1));
    expect(label([valueLte, period()])).toBe("(a) allowance, per period, per call");
    expect(label([period(), valueLte])).toBe("(a) allowance, per period, per call");
  });
  it("(3) amount: per period, total; call-terms do not change it", () => {
    expect(label([period()])).toBe("(a) allowance, per period");
    expect(label([cv(E.ERC20TransferAmount, concat([USDC, u256(9)])), cv(E.AllowedTargets, USDC)])).toBe("(a) allowance, total");
  });
  it("balance change: class by mode, decoded from terms", () => {
    expect(label([balanceChange(true)])).toBe("(a) allowance, per execution");
    expect(label([balanceChange(false)])).toBe(LABEL.d);
    expect(label([cv(E.ERC20BalanceChange, "0x01")])).toBe(LABEL.c); // terms do not decode: mode unknown
  });
  it("scope-only alone → (d): NativeTokenPayment, MultiOperationIncreaseBalance", () => {
    expect(label([cv(E.NativeTokenPayment, concat([ALICE, u256(1)]))])).toBe(LABEL.d);
    expect(label([cv(E.ERC20MultiOpIncrease, concat([USDC, ALICE, u256(1)]))])).toBe(LABEL.d);
  });
  it("LogicalOrWrapper takes the weakest group", () => {
    expect(label([wrapper([[period()], [cv(E.Redeemer, ALICE)]])])).toBe(LABEL.d);
    expect(label([wrapper([[period()], [cv(UNKNOWN)]])])).toBe(LABEL.c);
    expect(label([wrapper([[period()], [exact(), limited(2)]])])).toBe("any of {(a) allowance, per period; (b) exact execution, 2 times}");
    // Top-level caveats apply to every group.
    expect(label([limited(1), wrapper([[exact()], [exact(), limited(4)]])])).toBe(LABEL.bOnce);
    expect(label([cv(E.LogicalOrWrapper, "0x1234")])).toBe(LABEL.c);
  });
});

// ── SpendPermissionManager (P0-4 fixtures) ──

describe("spend permission fixtures", () => {
  const { logs } = fixture("spm-logs.json");
  it("has ≥5 approvals, both chains", () => {
    const approved = logs.filter((l: any) => l.log.topics[0] === toEventSelector(SpendPermissionManagerAbi[0]));
    expect(approved.length).toBeGreaterThanOrEqual(5);
    expect(new Set(approved.map((l: any) => l.chainId))).toEqual(new Set([42161, 8453]));
  });
  for (const l of fixture("spm-logs.json").logs) {
    it(`${l.chainId}-${l.tx}-${l.log.logIndex}: (a) per period; account is word 1 of data`, () => {
      const e = decodeEventLog({ abi: SpendPermissionManagerAbi, topics: l.log.topics, data: l.log.data });
      expect(["SpendPermissionApproved", "SpendPermissionRevoked"]).toContain(e.eventName);
      const p = (e.args as { spendPermission: SpendPermission }).spendPermission;
      // Approved/Revoked index only hash (s3 §11.14 #3): the account is the struct's first word, data[66:130].
      expect(l.log.topics).toHaveLength(2);
      expect(`0x${l.log.data.slice(90, 130)}`).toBe(p.account.toLowerCase());
      const s = shapeOfSpm(p);
      expect(s.label).toBe("(a) allowance, per period");
      expect(s.terms).toEqual({ allowance: p.allowance.toString(), period: p.period, start: p.start, end: p.end, token: p.token });
    });
  }
});

// ── Agent Credit Lines: synthetic logs from the ABI (R-S189-6) ──

describe("Agent Credit Lines decoder (synthetic)", () => {
  const LENDER: Address = "0x2222222222222222222222222222222222222222";
  const enc = (eventName: "Borrowed" | "Repaid" | "Defaulted", indexed: Record<string, unknown>, types: string, values: unknown[]) => ({
    topics: encodeEventTopics({ abi: AgentCreditLineAbi, eventName, args: indexed as never }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(parseAbiParameters(types), values as never),
  });
  const set1 = [
    enc("Borrowed", { loanId: 1n, agentId: 42n, to: ALICE }, "uint256, uint256, uint64", [1_000_000n, 10_000n, 1_800_000_000n]),
    enc("Repaid", { loanId: 1n, agentId: 42n, payer: ALICE }, "uint256, uint256", [1_000_000n, 10_000n]),
  ];
  const set2 = [
    enc("Borrowed", { loanId: 2n, agentId: 42n, to: ALICE }, "uint256, uint256, uint64", [500_000n, 5_000n, 1_800_000_000n]),
    enc("Defaulted", { loanId: 2n, agentId: 42n, owner: ALICE }, "uint256", [500_000n]),
  ];

  it("topic0s equal s3 §6.4b (6)", () => {
    expect(set1[0]!.topics[0]).toBe("0x629355c554c974447ea37d858c9e39385b02dcfd05e66f0e83248b951e38fc43");
    expect(set1[1]!.topics[0]).toBe("0xa7de81cb918e3d3d2e10d944b5a81f22d525eab1b926370283d4b9e997d445bb");
    expect(set2[1]!.topics[0]).toBe("0xea69a7290a8c5d33d720c1f1d3c299e3dd66d74e4ee6e570048e59068d9b04df");
  });
  it("Borrowed → Repaid and Borrowed → Defaulted decode; label is (e) with the writer named", () => {
    const kinds = [...set1, ...set2].map((l) => decodeEventLog({ abi: AgentCreditLineAbi, ...l }));
    expect(kinds.map((k) => k.eventName)).toEqual(["Borrowed", "Repaid", "Borrowed", "Defaulted"]);
    expect(kinds.map((k) => (k.args as { agentId: bigint }).agentId)).toEqual([42n, 42n, 42n, 42n]);
    expect((kinds[0]!.args as { dueAt: bigint }).dueAt).toBe(1_800_000_000n);
    expect(attestationLabel(LENDER)).toBe(`(e) third-party attestation, writer named: ${LENDER}`);
  });
});

// ── NablaZ account label ──

describe("nablaLabel", () => {
  const BOOT: Address = "0xCa3330683eD6659B44EBA03B8d057e65e6Ff2eD5";
  const V3: Address = "0x2DE2f1da0B9d47Ec417Ad10f909f8740E0b027fA";
  const V31: Address = "0x3786B747AEf4E31A7A45cc7EBBBc8C462927AcDc";
  const CAM: Hex = `0x${"ab".repeat(32)}`;
  const base = { lineage: [V3, V31], bootstrap: BOOT, camV4CodeHash: CAM };
  it("canonical lineage and CAM V4 code hash → within mandate by construction", () => {
    expect(nablaLabel({ ...base, implementations: [BOOT, V31], mandateCodeHash: CAM }).label).toBe("(a) within mandate by construction");
    expect(nablaLabel({ ...base, implementations: [BOOT, V3, V31], mandateCodeHash: CAM }).shape).toBe("a");
  });
  it("non-canonical implementation → (c)", () => {
    const r = nablaLabel({ ...base, implementations: [BOOT, ALICE], mandateCodeHash: CAM });
    expect(r).toMatchObject({ shape: "c", label: LABEL.c, canonicalImpl: false });
  });
  it("bootstrap is accepted only as the first implementation", () => {
    expect(canonicalLineage({ ...base, implementations: [V31, BOOT] }).ok).toBe(false);
    expect(canonicalLineage({ ...base, implementations: [BOOT] }).ok).toBe(false);
  });
  it("mandate code hash ≠ CAM V4 → (c), lineage still canonical", () => {
    expect(nablaLabel({ ...base, implementations: [BOOT, V31], mandateCodeHash: `0x${"cd".repeat(32)}` })).toMatchObject({ shape: "c", canonicalImpl: true });
  });
});
