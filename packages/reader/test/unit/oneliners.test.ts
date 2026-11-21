// R-D2B-1: every s3 §6.4b command line has a renderer, and each renderer reproduces its line(s) exactly. Since the
// item-10 rider (S224 ruling, R-S226-4) lines (1) and (8) read both records, as §6.4b prints them at 9ece0f19.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AS_PRINTED_CHAIN, ONELINERS, render, type OnelinerId } from "../../src/oneliners";

const text = readFileSync(new URL("../fixtures/s3-6.4b-oneliners.txt", import.meta.url), "utf8");
const lines = text.split("\n").filter((l) => l.startsWith("cast "));
const ids = Object.keys(ONELINERS) as OnelinerId[];

describe("s3 §6.4b one-liners", () => {
  it("fixture is pinned to the s3 commit", () => {
    expect(text).toContain("9ece0f1964cc0de6e8ac53d901ce6cad4190ab93");
    expect(lines).toHaveLength(20);
  });

  it("every line has a renderer, in section order, reproducing it exactly; (1) and (8) render a line per record", () => {
    const rendered = ids.flatMap((id) => render(id, { chainId: AS_PRINTED_CHAIN[id] }).split("\n"));
    expect(rendered).toEqual(lines);
    for (const id of ["1-record-entries", "8-controller-rotated-by-self"] as const) {
      const [v1, v2] = render(id, { chainId: 42161 }).split("\n");
      expect(v1, id).toContain("--from-block 516635327 --address 0x80E937f9DEf48060308Ee00EC279d8448d4775b0 ");
      expect(v2, id).toContain("--from-block 524296058 --address 0x2618c4e053E9fA8f02Cb26007Fa3c0E4951F9e57 ");
    }
  });

  it("substitutes the subject and the chain's RPC variable, never a URL", () => {
    const s = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
    const out = render("1-record-entries", { chainId: 42161, subject: s });
    for (const line of out.split("\n")) expect(line.endsWith(` ${s}`)).toBe(true);
    expect(out).not.toContain("<SUBJECT>");
    for (const line of render("8-controller-rotated-by-self", { chainId: 42161, account: s }).split("\n")) expect(line).not.toContain("<ACCOUNT>");
    expect(render("5-redeemed-delegation", { chainId: 8453, rootDelegator: s, from: 28207787 })).toContain('--rpc-url "$BASE_RPC_URL" --from-block 28207787 ');
    expect(render("5-redeemed-delegation", { chainId: 137, rootDelegator: s, from: 69623266 })).toContain('--rpc-url "$POLYGON_RPC_URL"');
    for (const id of ids) expect(render(id, { chainId: 8453 })).not.toMatch(/https?:\/\//);
  });

  it("renders a record row from its own emitter only; no emitter renders both, per emitter (R-S221-4, item-10 rider)", () => {
    const s = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
    const both = render("1-record-entries", { chainId: 42161, subject: s }).split("\n");
    expect(both).toHaveLength(2);
    const v1 = render("1-record-entries", { chainId: 42161, subject: s, record: "0x80e937f9def48060308ee00ec279d8448d4775b0" });
    const v2 = render("1-record-entries", { chainId: 42161, subject: s, record: "0x2618c4e053e9fa8f02cb26007fa3c0e4951f9e57" });
    expect([v1, v2]).toEqual(both);
    expect(v2).toBe(v1.replace("--from-block 516635327 --address 0x80E937f9DEf48060308Ee00EC279d8448d4775b0", "--from-block 524296058 --address 0x2618c4e053E9fA8f02Cb26007Fa3c0E4951F9e57"));
    expect(() => render("1-record-entries", { chainId: 42161, subject: s, record: "0x000000000000000000000000000000000000dEaD" })).toThrow(/not a NablaZ record/);
  });

  it("refuses an unknown chain", () => {
    expect(() => render("4-spm-used", { chainId: 1 })).toThrow(/no RPC variable/);
  });
});
