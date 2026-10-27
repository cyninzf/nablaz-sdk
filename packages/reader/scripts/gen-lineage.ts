// Generates src/generated/account-lineage.json (R-S189-4 AMENDED 2) and the byte copy of its source,
// test/fixtures/permanent-arbitrum.txt, from nablaz-protocol script/expected/permanent-arbitrum.txt at a
// pinned commit. Addresses are copied from that file by name, never retyped. test/unit/lineage.test.ts
// checks the JSON against the copy, and the copy against the commit's blob id.
//
//   node --experimental-strip-types scripts/gen-lineage.ts <path-to-nablaz-protocol> [sha]
//
// Reads the file at the commit (git show), so the checkout's working tree and HEAD do not matter.
// Not run in CI: CI has no access to nablaz-protocol.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const SOURCE = "script/expected/permanent-arbitrum.txt";
const PINNED = "d6aaba99a4f3e4b98fe10fdfddea42ee76f8745d";

// Oldest first. `provenance` is how each became ProtocolConfig.currentAccountImpl, from s3 at PINNED.
const LINEAGE = [
  { name: "NablaAccountV3", provenance: "ProtocolConfig.initialize sets currentAccountImpl = NablaAccountV3 (P1 sequence, Ledger step 7; s3 §8.1)" },
  {
    name: "NablaAccountV3_1",
    provenance:
      "Safe nonce 147 setCurrentAccountImpl(NablaAccountV3_1), tx 0x4e6fc2c23182ea9ec1b56039524eafaee19346be8c1146c616d23989c65a1033, block 517848229 (s3 §10 row VF)",
  },
] as const;

const proto = process.argv[2];
const sha = process.argv[3] ?? PINNED;
if (!proto) throw new Error("usage: gen-lineage.ts <path-to-nablaz-protocol> [sha]");
const git = (...args: string[]) => execFileSync("git", ["-C", proto, ...args], { encoding: "utf8" });
const full = git("rev-parse", `${sha}^{commit}`).trim();
const blob = git("rev-parse", `${full}:${SOURCE}`).trim();
const text = git("show", `${full}:${SOURCE}`);

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
  note:
    "Implementations ProtocolConfig has published as currentAccountImpl, oldest first. An account is in the lineage when its Upgraded events name only these, after at most one first Upgraded to the bootstrap.",
  lineage: LINEAGE.map((l) => ({ name: l.name, address: pick(l.name), provenance: l.provenance })),
  bootstrap: { name: "NablaAccountBootstrap", address: pick("NablaAccountBootstrap") },
  protocolConfig: { name: "ProtocolConfig", address: pick("ProtocolConfig") },
};

writeFileSync(new URL("../src/generated/account-lineage.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(new URL("../test/fixtures/permanent-arbitrum.txt", import.meta.url), text);
console.log(`account-lineage.json from ${SOURCE} at ${full} (blob ${blob})`);
