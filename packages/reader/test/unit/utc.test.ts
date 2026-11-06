// R-S205-5: `<field>Utc` beside every epoch-second field of /read's facts (src/api/utc.ts).

import { describe, expect, it } from "vitest";
import { utcOf, withUtc } from "../../src/api/utc";

describe("utcOf", () => {
  it("1793491200 is 2026-11-01T00:00:00Z (the regression: a consuming client read it as 2027)", () => {
    expect(utcOf(1793491200)).toBe("2026-11-01T00:00:00Z");
    expect(utcOf("1793491200")).toBe("2026-11-01T00:00:00Z");
    expect(utcOf(1793491200n)).toBe("2026-11-01T00:00:00Z");
  });
  it("writes YYYY-MM-DDTHH:MM:SSZ, seconds kept, no milliseconds", () => {
    expect(utcOf(0)).toBe("1970-01-01T00:00:00Z");
    expect(utcOf("1793972734")).toBe("2026-11-06T13:45:34Z");
    expect(utcOf(253402300799)).toBe("9999-12-31T23:59:59Z");
  });
  it("null where no four-digit-year instant exists, the raw field beside it says it", () => {
    expect(utcOf(null)).toBeNull();
    expect(utcOf(undefined)).toBeNull();
    expect(utcOf("281474976710655")).toBeNull(); // uint48 max: SpendPermission's "no end"
    expect(utcOf(-1)).toBeNull();
    expect(utcOf("12.5")).toBeNull();
    expect(utcOf("0x10")).toBeNull();
  });
});

describe("withUtc", () => {
  const vaultPayment = {
    source: "nablaz:vault_payment",
    terms: { value: "1000000", authorization: { envelopeStatus: "determinate", envelopeExpiry: "1793491200", grantMatchesEnvelope: true } },
    cite: { chainId: 42161, block: "1", tx: "0x01", logIndex: 0 },
  };

  it("adds envelopeExpiryUtc right after envelopeExpiry and leaves the raw field and everything else as it was", () => {
    const [f] = withUtc([vaultPayment]) as (typeof vaultPayment & { terms: { authorization: Record<string, unknown> } })[];
    expect(f!.terms.authorization).toEqual({ envelopeStatus: "determinate", envelopeExpiry: "1793491200", envelopeExpiryUtc: "2026-11-01T00:00:00Z", grantMatchesEnvelope: true });
    expect(Object.keys(f!.terms.authorization)).toEqual(["envelopeStatus", "envelopeExpiry", "envelopeExpiryUtc", "grantMatchesEnvelope"]);
    expect(f!.cite).toEqual(vaultPayment.cite);
    expect(vaultPayment.terms.authorization).not.toHaveProperty("envelopeExpiryUtc"); // input not mutated
  });

  it("a null epoch gets a null sibling", () => {
    const [f] = withUtc([{ ...vaultPayment, terms: { authorization: { envelopeExpiry: null } } }]) as any[];
    expect(f.terms.authorization).toEqual({ envelopeExpiry: null, envelopeExpiryUtc: null });
  });

  it("credit lines: dueAt", () => {
    const [f] = withUtc([{ source: "agent_credit_lines", terms: { principal: "5", dueAt: "1793491200" } }]) as any[];
    expect(f.terms).toEqual({ principal: "5", dueAt: "1793491200", dueAtUtc: "2026-11-01T00:00:00Z" });
  });

  it("spend permissions: start and end (sentinel end → null); period is a duration and gets none", () => {
    const [f] = withUtc([{ source: "coinbase:spend_permission", terms: { allowance: "1", period: 86400, start: 1793491200, end: 281474976710655, token: "0x" } }]) as any[];
    expect(f.terms).toEqual({ allowance: "1", period: 86400, start: 1793491200, startUtc: "2026-11-01T00:00:00Z", end: 281474976710655, endUtc: null, token: "0x" });
  });

  it("start/end outside a spend permission's own terms get no sibling", () => {
    const [f] = withUtc([{ source: "metamask:delegation", terms: { start: 1793491200, end: 1793491200, nested: { start: 1 } } }]) as any[];
    expect(f.terms).toEqual({ start: 1793491200, end: 1793491200, nested: { start: 1 } });
  });

  it("decoded caveats, nested in groups: startDate, startTime, afterTimestamp, beforeTimestamp", () => {
    const enforcers = [
      { name: "TimestampEnforcer", terms: { afterTimestamp: "1793491200", beforeTimestamp: "0" }, groups: [[{ name: "ERC20StreamingEnforcer", terms: { startTime: "1793491200", amountPerSecond: "3" } }]] },
      { name: "ERC20PeriodTransferEnforcer", terms: { periodDuration: "86400", startDate: "1793491200" } },
    ];
    const [f] = withUtc([{ source: "metamask:redemption", terms: { enforcers } }]) as any[];
    const [ts, period] = f.terms.enforcers;
    expect(ts.terms).toEqual({ afterTimestamp: "1793491200", afterTimestampUtc: "2026-11-01T00:00:00Z", beforeTimestamp: "0", beforeTimestampUtc: "1970-01-01T00:00:00Z" });
    expect(ts.groups[0][0].terms).toEqual({ startTime: "1793491200", startTimeUtc: "2026-11-01T00:00:00Z", amountPerSecond: "3" });
    expect(period.terms).toEqual({ periodDuration: "86400", startDate: "1793491200", startDateUtc: "2026-11-01T00:00:00Z" });
  });

  it("a payment fact nested in a grounding fact gets its siblings too", () => {
    const [f] = withUtc([{ source: "erc8004:feedback", terms: { grounding: "grounded", payment: { ...vaultPayment, payer: "0xa" } } }]) as any[];
    expect(f.terms.payment.terms.authorization.envelopeExpiryUtc).toBe("2026-11-01T00:00:00Z");
    expect(f.terms.payment.payer).toBe("0xa");
  });

  it("never overwrites an existing <field>Utc", () => {
    const [f] = withUtc([{ source: "agent_credit_lines", terms: { dueAt: "1793491200", dueAtUtc: "kept" } }]) as any[];
    expect(f.terms.dueAtUtc).toBe("kept");
  });
});
