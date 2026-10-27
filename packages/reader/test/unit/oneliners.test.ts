// R-D2B-1: every s3 §6.4b command line has a renderer, and each renderer reproduces its line exactly.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AS_PRINTED_CHAIN, ONELINERS, render, type OnelinerId } from "../../src/oneliners";

const text = readFileSync(new URL("../fixtures/s3-6.4b-oneliners.txt", import.meta.url), "utf8");
const lines = text.split("\n").filter((l) => l.startsWith("cast "));
const ids = Object.keys(ONELINERS) as OnelinerId[];

describe("s3 §6.4b one-liners", () => {
  it("fixture is pinned to the s3 commit", () => {
    expect(text).toContain("51c1379622ec837375e5d8ddf42b29032990b997");
    expect(lines).toHaveLength(18);
  });

  it("one renderer per line, in section order, each reproducing the line exactly", () => {
    expect(ids).toHaveLength(lines.length);
    ids.forEach((id, i) => expect(render(id, { chainId: AS_PRINTED_CHAIN[id] }), id).toBe(lines[i]));
  });

  it("substitutes the subject and the chain's RPC variable, never a URL", () => {
    const s = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
    const line = render("1-record-entries", { chainId: 42161, subject: s });
    expect(line.endsWith(` ${s}`)).toBe(true);
    expect(line).not.toContain("<SUBJECT>");
    expect(render("5-redeemed-delegation", { chainId: 8453, rootDelegator: s, from: 28207787 })).toContain('--rpc-url "$BASE_RPC_URL" --from-block 28207787 ');
    for (const id of ids) expect(render(id, { chainId: 8453 })).not.toMatch(/https?:\/\//);
  });

  it("refuses an unknown chain", () => {
    expect(() => render("4-spm-used", { chainId: 1 })).toThrow(/no RPC variable/);
  });
});
