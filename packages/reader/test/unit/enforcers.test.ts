// R-S189-7 / R-S189-8: the enforcer table. (i) regenerated from the pinned commit equals the committed JSON;
// (ii) vendor drift: main may list no address the table lacks; (iii) an address in no vendor list yields (c).
// (iv) is the fork test's (c)-share line (test/fork/external.fork.test.ts).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENTS_COMMIT,
  DEPLOYMENTS_MAIN_URL,
  DEPLOYMENTS_URL,
  SUPERSEDED_NOTE,
  buildEnforcerTable,
  parseDeployments,
  serializeEnforcerTable,
} from "../../src/enforcer-table";
import { ENFORCER_TABLE, rowsFor } from "../../src/delegation";
import { LABEL, shapeOfDelegation } from "../../src/labels";

const committed = readFileSync(new URL("../../src/generated/enforcers.json", import.meta.url), "utf8");

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return r.text();
}

describe("enforcer table (R-S189-7)", () => {
  it("(i) regenerates byte-for-byte from Deployments.md at the pinned commit", async () => {
    expect(DEPLOYMENTS_URL).toContain(DEPLOYMENTS_COMMIT);
    expect(serializeEnforcerTable(buildEnforcerTable(await fetchText(DEPLOYMENTS_URL)))).toBe(committed);
  }, 60_000);

  it("(ii) vendor drift: every enforcer address on the vendor's main is in the table", async () => {
    const main = parseDeployments(await fetchText(DEPLOYMENTS_MAIN_URL));
    const lacking = main.filter((p) => rowsFor(p.address).length === 0).map((p) => `${p.name} ${p.address}`);
    expect(lacking, "the vendor moved; re-pin under a new ruling").toEqual([]);
  }, 60_000);

  it("(iii) an address in no vendor list yields (c): 0x29fcBBa8…0153, Base block 52968199", () => {
    const r = shapeOfDelegation([
      { enforcer: "0x29fcBBa852439616c4D614A2fa6411E42b760153", terms: "0x", args: "0x" },
      { enforcer: "0x04658B29F6b82ed55274221a06Fc97D318E25416", terms: `0x${"0".repeat(63)}1`, args: "0x" },
    ]);
    expect(r.shape).toBe("c");
    expect(r.label).toBe(LABEL.c);
    expect(r.enforcers[0]!.name).toBeNull();
  });

  it("has 42 rows with the ruled class counts", () => {
    const rows = ENFORCER_TABLE.rows;
    const n = (k: string) => rows.filter((r) => r.class === k).length;
    expect(rows).toHaveLength(42);
    expect({ amount: n("amount"), exactCall: n("exact-call"), callTerm: n("call-term"), scopeOnly: n("scope-only"), wrapper: n("wrapper") }).toEqual({
      amount: 12,
      exactCall: 9,
      callTerm: 5,
      scopeOnly: 15,
      wrapper: 1,
    });
  });

  it("keeps the superseded SpecificActionERC20TransferBatchEnforcer as its own single-use row", () => {
    const old = rowsFor("0x00e0251aaA263dfE3B3541B758A82D1CBA1c3B6D");
    expect(old).toHaveLength(1);
    expect(old[0]).toMatchObject({ name: "SpecificActionERC20TransferBatchEnforcer", class: "exact-call", singleUse: true, superseded: SUPERSEDED_NOTE, layout: "v1.3.0" });
    const now = rowsFor("0x6649b61c873F6F9686A1E1ae9ee98aC380c7bA13");
    expect(now[0]).toMatchObject({ class: "exact-call", singleUse: true, layout: "b4b8c41f" });
    expect(now[0]!.superseded).toBeUndefined();
  });

  it("classes the five rows added at b4b8c41f as ruled", () => {
    for (const n of ["ERC20", "ERC721", "ERC1155", "NativeToken"]) {
      const r = ENFORCER_TABLE.rows.filter((x) => x.name === `${n}MultiOperationIncreaseBalanceEnforcer`);
      expect(r.map((x) => x.class), n).toEqual(["scope-only"]);
    }
    expect(ENFORCER_TABLE.rows.find((x) => x.name === "ApprovalRevocationEnforcer")!.class).toBe("exact-call");
  });

  it("has one row per mode for the four balance-change enforcers", () => {
    for (const n of ["ERC20", "ERC721", "ERC1155", "Native"]) {
      const r = ENFORCER_TABLE.rows.filter((x) => x.name === `${n}BalanceChangeEnforcer`);
      expect(r.map((x) => `${x.mode}:${x.class}`), n).toEqual(["decrease:amount", "increase:scope-only"]);
    }
  });

  it("refuses a parsed enforcer with no class", () => {
    const md = `### **v1.3.0**\n\`\`\`\nNewThingEnforcer: 0x${"1".repeat(40)}\n\`\`\`\n`;
    expect(() => buildEnforcerTable(md)).toThrow();
  });
});
