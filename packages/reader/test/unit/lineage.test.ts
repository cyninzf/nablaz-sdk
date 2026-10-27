// R-S189-4 AMENDED 2: the currentAccountImpl lineage, bootstrap and ProtocolConfig come from
// src/generated/account-lineage.json, copied from nablaz-protocol script/expected/permanent-arbitrum.txt at
// the pinned commit (scripts/gen-lineage.ts). test/fixtures/permanent-arbitrum.txt is that file byte for byte;
// its git blob id is recorded in the JSON, so `git rev-parse <commit>:<path>` in nablaz-protocol checks it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import lineage from "../../src/generated/account-lineage.json" with { type: "json" };
import * as chains from "../../src/chains";
import { CURRENT_ACCOUNT_IMPL_LINEAGE, NABLA_ACCOUNT_BOOTSTRAP, PROTOCOL_CONFIG, canonicalLineage, nablaLabel } from "../../src/labels";

const PINNED = "d6aaba99a4f3e4b98fe10fdfddea42ee76f8745d";
const source = readFileSync(new URL("../fixtures/permanent-arbitrum.txt", import.meta.url));
const gitBlobId = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
/** `<name> <address>` lines of the source, as written. */
const sourceLines = source.toString("utf8").split("\n");

describe("account lineage data file", () => {
  it("names permanent-arbitrum.txt at the pinned proto commit, and the fixture is that blob", () => {
    expect(lineage.source).toEqual({ repo: "nablaz-protocol", path: "script/expected/permanent-arbitrum.txt", commit: PINNED, blob: lineage.source.blob });
    expect(gitBlobId(source)).toBe(lineage.source.blob);
    expect(lineage.chainId).toBe(42161);
    expect(sourceLines[0]).toBe("chainId 42161");
  });

  it("every address byte-matches its line in permanent-arbitrum.txt", () => {
    const entries = [...lineage.lineage, lineage.bootstrap, lineage.protocolConfig];
    expect(entries.map((e) => e.name)).toEqual(["NablaAccountV3", "NablaAccountV3_1", "NablaAccountBootstrap", "ProtocolConfig"]);
    for (const e of entries) expect(sourceLines.filter((l) => l === `${e.name} ${e.address}`), e.name).toHaveLength(1);
  });

  it("every lineage entry carries its provenance", () => {
    expect(lineage.lineage[0]!.provenance).toContain("s3 §8.1");
    expect(lineage.lineage[1]!.provenance).toContain("Safe nonce 147");
    expect(lineage.lineage[1]!.provenance).toContain("0x4e6fc2c23182ea9ec1b56039524eafaee19346be8c1146c616d23989c65a1033");
  });

  it("the exported constants are the JSON's, in order, and chains.ts re-exports them", () => {
    expect(CURRENT_ACCOUNT_IMPL_LINEAGE).toEqual(lineage.lineage.map((l) => l.address));
    expect(NABLA_ACCOUNT_BOOTSTRAP).toBe(lineage.bootstrap.address);
    expect(PROTOCOL_CONFIG).toBe(lineage.protocolConfig.address);
    expect(chains.CURRENT_ACCOUNT_IMPL_LINEAGE).toBe(CURRENT_ACCOUNT_IMPL_LINEAGE);
    expect(chains.NABLA_ACCOUNT_BOOTSTRAP).toBe(NABLA_ACCOUNT_BOOTSTRAP);
    expect(chains.PROTOCOL_CONFIG).toBe(PROTOCOL_CONFIG);
  });

  it("canonicalLineage and nablaLabel default to the JSON lineage and bootstrap", () => {
    const [v3, v31] = lineage.lineage.map((l) => l.address as Address);
    const boot = lineage.bootstrap.address as Address;
    const other: Address = "0x000000000000000000000000000000000000a11c";
    expect(canonicalLineage({ implementations: [boot, v31!] }).ok).toBe(true);
    expect(canonicalLineage({ implementations: [boot, v3!, v31!] }).ok).toBe(true);
    expect(canonicalLineage({ implementations: [boot, other] }).ok).toBe(false);
    expect(canonicalLineage({ implementations: [v31!, boot] }).ok).toBe(false);
    const cam = `0x${"ab".repeat(32)}` as const;
    expect(nablaLabel({ implementations: [boot, v31!], mandateCodeHash: cam, camV4CodeHash: cam }).shape).toBe("a");
    expect(nablaLabel({ implementations: [boot, other], mandateCodeHash: cam, camV4CodeHash: cam }).shape).toBe("c");
  });

  // Needs a nablaz-protocol checkout (CI has none): NABLAZ_PROTOCOL_DIR=/path/to/nablaz-protocol pnpm test
  it.runIf(!!process.env.NABLAZ_PROTOCOL_DIR)("the fixture equals nablaz-protocol's file at the pinned commit (NABLAZ_PROTOCOL_DIR)", () => {
    const dir = process.env.NABLAZ_PROTOCOL_DIR!;
    const atPin = execFileSync("git", ["-C", dir, "show", `${PINNED}:${lineage.source.path}`]);
    expect(Buffer.compare(atPin, source)).toBe(0);
    expect(execFileSync("git", ["-C", dir, "rev-parse", `${PINNED}:${lineage.source.path}`], { encoding: "utf8" }).trim()).toBe(lineage.source.blob);
  });
});
