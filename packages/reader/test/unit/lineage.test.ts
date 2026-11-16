// R-S189-4 AMENDED 2: the currentAccountImpl lineage, bootstrap and ProtocolConfig come from
// src/generated/account-lineage.json, copied from nablaz-protocol script/expected/permanent-arbitrum.txt and, for
// the G1 tip (R-S221-4), the deployment manifest deployments/arbitrum-one.json, both at the pinned commit
// (scripts/gen-lineage.ts). test/fixtures/permanent-arbitrum.txt and test/fixtures/arbitrum-one.json are those files
// byte for byte; their git blob ids are recorded in the JSON, so `git rev-parse <commit>:<path>` checks them.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import lineage from "../../src/generated/account-lineage.json" with { type: "json" };
import * as chains from "../../src/chains";
import { CURRENT_ACCOUNT_IMPL_LINEAGE, NABLA_ACCOUNT_BOOTSTRAP, PROTOCOL_CONFIG, canonicalLineage, nablaLabel } from "../../src/labels";

const PINNED = "1ab54ecd37a3609d2f7de1e94e57c944498bbc19";
const source = readFileSync(new URL("../fixtures/permanent-arbitrum.txt", import.meta.url));
const manifestBytes = readFileSync(new URL("../fixtures/arbitrum-one.json", import.meta.url));
const manifest = JSON.parse(manifestBytes.toString("utf8")) as { chainId: number; contracts: Record<string, string> };
const gitBlobId = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
/** `<name> <address>` lines of the source, as written. */
const sourceLines = source.toString("utf8").split("\n");

describe("account lineage data file", () => {
  it("names permanent-arbitrum.txt at the pinned proto commit, and the fixture is that blob", () => {
    expect(lineage.source).toEqual({ repo: "nablaz-protocol", path: "script/expected/permanent-arbitrum.txt", commit: PINNED, blob: lineage.source.blob });
    expect(gitBlobId(source)).toBe(lineage.source.blob);
    expect(lineage.chainId).toBe(42161);
    expect(sourceLines[0]).toBe("chainId 42161");
    expect(lineage.manifest).toEqual({ repo: "nablaz-protocol", path: "deployments/arbitrum-one.json", commit: PINNED, blob: lineage.manifest.blob });
    expect(gitBlobId(manifestBytes)).toBe(lineage.manifest.blob);
    expect(manifest.chainId).toBe(42161);
  });

  it("every address byte-matches its source: its line in permanent-arbitrum.txt, or the manifest's contracts for a from-manifest entry", () => {
    const entries = [...lineage.lineage, lineage.bootstrap, lineage.protocolConfig];
    expect(entries.map((e) => e.name)).toEqual(["NablaAccountV3", "NablaAccountV3_1", "NablaAccountV3_2", "NablaAccountBootstrap", "ProtocolConfig"]);
    for (const e of entries) {
      if ("from" in e) {
        expect(e.from, e.name).toBe("deployments/arbitrum-one.json");
        expect(manifest.contracts[e.name], e.name).toBe(e.address);
        // A from-manifest entry is one permanent-arbitrum.txt does not list (else it would be read from there).
        expect(sourceLines.some((l) => l.startsWith(`${e.name} `)), e.name).toBe(false);
      } else expect(sourceLines.filter((l) => l === `${e.name} ${e.address}`), e.name).toHaveLength(1);
    }
  });

  it("every lineage entry carries its provenance", () => {
    expect(lineage.lineage[0]!.provenance).toContain("s3 §8.1");
    expect(lineage.lineage[1]!.provenance).toContain("Safe nonce 147");
    expect(lineage.lineage[1]!.provenance).toContain("0x4e6fc2c23182ea9ec1b56039524eafaee19346be8c1146c616d23989c65a1033");
    expect(lineage.lineage[2]!.provenance).toContain("Safe nonce 159");
    expect(lineage.lineage[2]!.provenance).toContain("0xdb14c1c6f9d74eda7e36cc9e0774424494b88c362b2893b87420927f7e919cb2");
  });

  it("the lineage tip is NablaAccountV3_2 (R-S221-4; the live-state monitor reads it against ProtocolConfig)", () => {
    expect(CURRENT_ACCOUNT_IMPL_LINEAGE.at(-1)).toBe("0xa581b2888AD131D42F18C2eED1051A4576Ca06B9");
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
    const [v3, v31, v32] = lineage.lineage.map((l) => l.address as Address);
    const boot = lineage.bootstrap.address as Address;
    const other: Address = "0x000000000000000000000000000000000000a11c";
    expect(canonicalLineage({ implementations: [boot, v31!] }).ok).toBe(true);
    expect(canonicalLineage({ implementations: [boot, v3!, v31!] }).ok).toBe(true);
    expect(canonicalLineage({ implementations: [boot, v32!] }).ok).toBe(true);
    expect(canonicalLineage({ implementations: [boot, v31!, v32!] }).ok).toBe(true);
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
    expect(Buffer.compare(execFileSync("git", ["-C", dir, "show", `${PINNED}:${lineage.manifest.path}`]), manifestBytes)).toBe(0);
  });
});
