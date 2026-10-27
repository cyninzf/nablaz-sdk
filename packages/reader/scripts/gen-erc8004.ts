// Generates src/generated/erc8004.json: the ERC-8004 Identity and Reputation Registry addresses per chain,
// copied from nablaz-protocol script/expected/external-{arbitrum,base}.txt at a pinned commit (which copy them
// from erc-8004/erc-8004-contracts README.md at the vendor commit they cite), and the ABI items the reader
// uses, copied from the vendor's abis/*.json at that vendor commit. Nothing is retyped.
// test/unit/erc8004.test.ts re-reads the vendor README at the pinned commit.
//
//   node --experimental-strip-types scripts/gen-erc8004.ts <path-to-nablaz-protocol> [sha]
//
// Not run in CI: CI has no access to nablaz-protocol.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PINNED = "51c1379622ec837375e5d8ddf42b29032990b997";
const FILES = { 42161: "script/expected/external-arbitrum.txt", 8453: "script/expected/external-base.txt" } as const;
const NAMES = { IdentityRegistry: "ERC8004IdentityRegistry", ReputationRegistry: "ERC8004ReputationRegistry" } as const;
const ITEMS = { IdentityRegistry: ["MetadataSet", "getAgentWallet"], ReputationRegistry: ["NewFeedback"] } as const;

const proto = process.argv[2];
const sha = process.argv[3] ?? PINNED;
if (!proto) throw new Error("usage: gen-erc8004.ts <path-to-nablaz-protocol> [sha]");
const git = (...args: string[]) => execFileSync("git", ["-C", proto, ...args], { encoding: "utf8" });
const full = git("rev-parse", `${sha}^{commit}`).trim();

let vendorCommit: string | undefined;
const chains: Record<string, Record<string, string>> = {};
for (const [chainId, path] of Object.entries(FILES)) {
  const out: Record<string, string> = {};
  for (const line of git("show", `${full}:${path}`).split("\n")) {
    const [name, address, url] = line.trim().split(/\s+/);
    for (const [key, protoName] of Object.entries(NAMES)) {
      if (name !== protoName) continue;
      const m = /^https:\/\/github\.com\/erc-8004\/erc-8004-contracts\/blob\/([0-9a-f]{40})\/README\.md$/.exec(url ?? "");
      if (!m) throw new Error(`${path}: ${name} has no vendor URL at a pinned commit`);
      if (vendorCommit && vendorCommit !== m[1]) throw new Error(`${path}: vendor commits differ (${vendorCommit}, ${m[1]})`);
      vendorCommit = m[1];
      out[key] = address!;
    }
  }
  for (const key of Object.keys(NAMES)) if (!out[key]) throw new Error(`${path} at ${full} lacks ${key}`);
  chains[chainId] = out;
}

const abi: unknown[] = [];
for (const [contract, names] of Object.entries(ITEMS)) {
  const url = `https://raw.githubusercontent.com/erc-8004/erc-8004-contracts/${vendorCommit}/abis/${contract}.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  const j = (await r.json()) as unknown;
  const items = (Array.isArray(j) ? j : (j as { abi: unknown[] }).abi) as { name?: string }[];
  for (const n of names) {
    const item = items.find((x) => x.name === n);
    if (!item) throw new Error(`${contract}.json lacks ${n}`);
    abi.push({ contract, ...item });
  }
}

const out = {
  source: {
    addresses: { repo: "nablaz-protocol", commit: full, files: Object.values(FILES) },
    vendor: { repo: "erc-8004/erc-8004-contracts", commit: vendorCommit, readme: `https://github.com/erc-8004/erc-8004-contracts/blob/${vendorCommit}/README.md` },
  },
  chains,
  abi,
};
writeFileSync(new URL("../src/generated/erc8004.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`erc8004.json from nablaz-protocol ${full}, vendor ${vendorCommit}`);
