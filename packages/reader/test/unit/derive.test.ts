import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, pad, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import {
  AUTHORIZATION_USED_TOPIC,
  ENVELOPE_CHANGED,
  KIND,
  TRANSFER_TOPIC,
  callsForSettlement,
  castEnvelopeOf,
  castLogs,
  granteeKeyOf,
  kindName,
  pairTransfer,
  predictVault,
  resolveEnvelope,
  vaultSettlementsInReceipt,
  type ReceiptLog,
} from "../../src/derive";
import { CHAINS, enabledChains } from "../../src/chains";
import { ARBITRUM_ONE, PROTO_SHA } from "@nablaz/sdk/addresses";
import { ABI_PROTO_SHA } from "@nablaz/sdk/abis";

const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const topicOf = (a: Address) => pad(a, { size: 32 }).toLowerCase() as Hex;

describe("kinds", () => {
  it("hashes kind names", () => {
    expect(KIND.PAY_AUTHORIZED).toBe(keccak256(stringToHex("PAY_AUTHORIZED")));
    expect(kindName(KIND.OBLIGATION_OPENED)).toBe("OBLIGATION_OPENED");
    expect(kindName(keccak256(stringToHex("NOT_A_KIND")))).toBeNull();
  });
});

describe("vault address from logs (P0-4)", () => {
  // Known answer from the Phase 0 fork run at Arbitrum block 517348000: agent key 0xB0A6E47's vault on
  // account 0xF7C3…41b8 is 0x6F30…343b.
  it("predicts the vault from (impl, account, granteeKeyOf(grantee, 0))", () => {
    const agent = privateKeyToAddress(pad("0xB0A6E47", { size: 32 }));
    const key = granteeKeyOf(agent, 0n);
    expect(key).toBe(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [0, agent])));
    expect(predictVault(ARBITRUM_ONE.contracts.GranteeVault.address, "0xF7C3E8dBC88c98c6D2E4700cA2996dA8adE441b8", key)).toBe(
      "0x6F30607A57d9671d0323d95E6DBbB32c46C5343b",
    );
  });

  it("keys agentId grants by agentId", () => {
    expect(granteeKeyOf("0x0000000000000000000000000000000000000001", 7n)).toBe(
      keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [1, 7n])),
    );
  });
});

describe("settlement pairing (P0-1) and batch-aware counts (R-D2B-6)", () => {
  const v1: Address = "0x00000000000000000000000000000000000000a1";
  const v2: Address = "0x00000000000000000000000000000000000000a2";
  const payee: Address = "0x00000000000000000000000000000000000000b0";
  const auth = (vault: Address, i: number): ReceiptLog => ({
    address: USDC,
    topics: [AUTHORIZATION_USED_TOPIC, topicOf(vault), pad("0x01", { size: 32 })],
    data: "0x",
    logIndex: i,
  });
  const xfer = (from: Address, value: bigint, i: number): ReceiptLog => ({
    address: USDC,
    topics: [TRANSFER_TOPIC, topicOf(from), topicOf(payee)],
    data: pad(`0x${value.toString(16)}`, { size: 32 }),
    logIndex: i,
  });
  // Two vault settlements and one foreign authorization in one tx.
  const logs = [auth(v1, 3), xfer(v1, 5n, 4), auth(v2, 5), xfer(v2, 7n, 6), auth("0x00000000000000000000000000000000000000ff", 7)];

  it("pairs each AuthorizationUsed with the next Transfer from its vault", () => {
    expect(pairTransfer(logs, USDC, v1, 3)).toMatchObject({ logIndex: 4, value: 5n });
    expect(pairTransfer(logs, USDC, v2, 5)).toMatchObject({ logIndex: 6, value: 7n });
    expect(pairTransfer(logs, USDC, v1, 4)).toBeNull();
  });

  it("counts settlements per log, only for known vaults", () => {
    const isVault = (a: Address) => [v1, v2].map((x) => x.toLowerCase()).includes(a.toLowerCase());
    expect(vaultSettlementsInReceipt(logs, USDC, isVault)).toEqual([3, 5]);
  });

  it("reports calls as not determinable", () => {
    expect(callsForSettlement(0).calls).toBeNull();
    expect(callsForSettlement(0).callsStatus).toMatch(/^not determinable/);
    expect(callsForSettlement(2).callsStatus).toMatch(/^not determinable/);
  });
});

describe("envelope (R-S184-2)", () => {
  const g = pad("0x01", { size: 32 });
  it("stores the value when N−1 and N agree", () => {
    expect(resolveEnvelope({ grantId: g, expiry: 10n }, { grantId: g, expiry: 10n })).toEqual({
      envelopeStatus: "determinate",
      envelopeGrantId: g,
      envelopeExpiry: 10n,
    });
  });
  it("is not determinable when the envelope changed within block N", () => {
    const r = resolveEnvelope({ grantId: g, expiry: 10n }, { grantId: g, expiry: 11n });
    expect(r.envelopeStatus).toBe(ENVELOPE_CHANGED);
    expect(r.envelopeExpiry).toBeNull();
  });
  it("cites the archive call", () => {
    expect(castEnvelopeOf(5n, USDC, USDC, g, USDC)).toMatch(/^cast call --block 5 /);
    expect(castLogs(5n, USDC, [TRANSFER_TOPIC])).toContain("--from-block 5 --to-block 5");
  });
});

describe("chains", () => {
  it("has Arbitrum enabled and Base present but disabled", () => {
    expect(enabledChains().map((c) => c.chainId)).toEqual([42161]);
    expect(CHAINS[8453]?.enabled).toBe(false);
    expect(CHAINS[8453]?.contracts.NablaAccountFactoryPermanent).toBe(CHAINS[42161]?.contracts.NablaAccountFactoryPermanent);
  });
  it("refuses to enable a chain with an unpublished address", () => {
    expect(() => enabledChains({ 8453: { ...CHAINS[8453]!, enabled: true } })).toThrow(/has no address/);
  });
  it("addresses and ABIs come from the same protocol commit", () => {
    expect(PROTO_SHA).toBe(ABI_PROTO_SHA);
  });
});
