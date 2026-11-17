// Generates src/generated/account-lineage.json (R-S189-4 AMENDED 2) and the byte copies of its sources,
// test/fixtures/permanent-arbitrum.txt and test/fixtures/arbitrum-one.json, from nablaz-protocol
// script/expected/permanent-arbitrum.txt and the deployment manifest of record deployments/arbitrum-one.json, both
// at one pinned commit. Addresses are copied from those files by name, never retyped: a lineage entry with
// `from: "manifest"` (G1, not in permanent-arbitrum.txt) comes from the manifest's `contracts`, every other one from
// permanent-arbitrum.txt. test/unit/lineage.test.ts checks the JSON against the copies, and the copies against the
// commit's blob ids.
//
//   node --experimental-strip-types scripts/gen-lineage.ts <path-to-nablaz-protocol> [sha]
//
// Reads the file at the commit (git show), so the checkout's working tree and HEAD do not matter.
// Not run in CI: CI has no access to nablaz-protocol.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const SOURCE = "script/expected/permanent-arbitrum.txt";
const MANIFEST = "deployments/arbitrum-one.json";
// R-S221-4: moved from d6aaba99 (permanent-arbitrum.txt has the same blob at both) to carry the G1 manifest.
const PINNED = "1ab54ecd37a3609d2f7de1e94e57c944498bbc19";

// Oldest first. `provenance` is how each became ProtocolConfig.currentAccountImpl, from s3 at PINNED.
const LINEAGE = [
  { name: "NablaAccountV3", provenance: "ProtocolConfig.initialize sets currentAccountImpl = NablaAccountV3 (P1 sequence, Ledger step 7; s3 §8.1)" },
  {
    name: "NablaAccountV3_1",
    provenance:
      "Safe nonce 147 setCurrentAccountImpl(NablaAccountV3_1), tx 0x4e6fc2c23182ea9ec1b56039524eafaee19346be8c1146c616d23989c65a1033, block 517848229 (s3 §10 row VF)",
  },
  {
    name: "NablaAccountV3_2",
    from: "manifest",
    provenance:
      "Safe nonce 159 setCurrentAccountImpl(NablaAccountV3_2), tx 0xdb14c1c6f9d74eda7e36cc9e0774424494b88c362b2893b87420927f7e919cb2, block 524308312, ProtocolConfig CurrentAccountImplSet (G1 act 12, S220; CTO sweep at block 524308580)",
  },
] as const satisfies readonly { name: string; from?: "manifest"; provenance: string }[];

const proto = process.argv[2];
const sha = process.argv[3] ?? PINNED;
if (!proto) throw new Error("usage: gen-lineage.ts <path-to-nablaz-protocol> [sha]");
const git = (...args: string[]) => execFileSync("git", ["-C", proto, ...args], { encoding: "utf8" });
const full = git("rev-parse", `${sha}^{commit}`).trim();
const blob = git("rev-parse", `${full}:${SOURCE}`).trim();
const text = git("show", `${full}:${SOURCE}`);
const manifestBlob = git("rev-parse", `${full}:${MANIFEST}`).trim();
const manifestText = git("show", `${full}:${MANIFEST}`);
const manifest = JSON.parse(manifestText) as { chainId: number; contracts: Record<string, string> };
if (manifest.chainId !== 42161) throw new Error(`${MANIFEST}: expected chainId 42161, got ${manifest.chainId}`);

const byName = new Map<string, string>();
let chainId: number | undefined;
for (const line of text.split("\n")) {
  const [name, value] = line.trim().split(/\s+/);
  if (name === "chainId") chainId = Number(value);
  else if (name && value?.startsWith("0x")) byName.set(name, value);
}
if (chainId !== 42161) throw new Error(`expected chainId 42161, got ${chainId}`);
const pick = (name: string) => {
  const a = byName.get(name);
  if (!a) throw new Error(`${name} missing from ${SOURCE} at ${full}`);
  return a;
};

const out = {
  chainId,
  source: { repo: "nablaz-protocol", path: SOURCE, commit: full, blob },
  manifest: { repo: "nablaz-protocol", path: MANIFEST, commit: full, blob: manifestBlob },
  note:
    "Implementations ProtocolConfig has published as currentAccountImpl, oldest first. An account is in the lineage when its Upgraded events name only these, after at most one first Upgraded to the bootstrap.",
  lineage: LINEAGE.map((l) => {
    if (!("from" in l)) return { name: l.name, address: pick(l.name), provenance: l.provenance };
    if (byName.has(l.name)) throw new Error(`${l.name} is in ${SOURCE} now: drop its from: "manifest"`);
    const address = manifest.contracts[l.name];
    if (!address) throw new Error(`${l.name} missing from ${MANIFEST} at ${full}`);
    return { name: l.name, address, from: MANIFEST, provenance: l.provenance };
  }),
  bootstrap: { name: "NablaAccountBootstrap", address: pick("NablaAccountBootstrap") },
  protocolConfig: { name: "ProtocolConfig", address: pick("ProtocolConfig") },
};

writeFileSync(new URL("../src/generated/account-lineage.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(new URL("../test/fixtures/permanent-arbitrum.txt", import.meta.url), text);
writeFileSync(new URL("../test/fixtures/arbitrum-one.json", import.meta.url), manifestText);
console.log(`account-lineage.json from ${SOURCE} (blob ${blob}) and ${MANIFEST} (blob ${manifestBlob}) at ${full}`);
