// Ponder's build id at given git revisions, reproduced outside Ponder (R-S206-2; method first written S202).
//
// Ponder 0.18.1 (build/index.ts:567): buildId = sha256("2" + configHash + schemaHash + indexingHash).slice(0, 10)
//   configHash   = sha256(superjson.stringify({ ordering, contracts, accounts, blocks })) of the evaluated
//                  ponder.config.ts (build/index.ts:291): addresses, ABIs, filters, start blocks; not RPC URLs.
//   schemaHash   = sha256 of ponder.schema.ts's raw text (build/index.ts:329).
//   indexingHash = sha256 over the raw text of every src/**/*.{js,mjs,ts,mts}, src/api/** and *.{test,spec}.* excluded,
//                  in the order Ponder's glob returns them (build/index.ts:351-366).
//
// Two findings this script encodes (S206):
// 1. The build id hashes the FILE SET, not only file contents: removing or moving a file out of src/ (outside
//    src/api/) moves the id exactly as editing it does. Relocating src/c-share.ts and src/wording.ts to lib/ moved
//    the id from 77bb04f918 to a1cb6b1278 (R-S206-3).
// 2. The S202 version of this method (kept only in a session transcript) globbed the WORKING TREE for the file list
//    and read each revision's contents into it. That is right only while every revision has the same file set; it
//    computes a wrong id for any revision that adds, removes or moves a counted file.
//
// Each revision's src/ and ponder.schema.ts are extracted with `git archive` into a temporary directory and globbed
// there exactly as Ponder globs, so a revision with a different file set hashes its own set. configHash is evaluated
// once from the working tree's ponder.config.ts (it imports the workspace through node_modules); a revision whose
// ponder.config.ts differs from the working tree's is flagged, and its id is only valid if the evaluated config is
// unchanged.
//
// Usage, from packages/reader, with DATABASE_URL unset and the RPC variables set to any URL (they are not hashed):
//   env -u DATABASE_URL READER_ARBITRUM_RPC_URL=http://127.0.0.1:1 READER_BASE_RPC_URL=http://127.0.0.1:1 \
//     READER_ARBITRUM_GROUNDING_RPC_URL=http://127.0.0.1:1 READER_BASE_GROUNDING_RPC_URL=http://127.0.0.1:1 \
//     node scripts/bid.mjs <rev>...
// Compare with the id Ponder recorded: `select value->>'build_id' from "<schema>"._ponder_meta where key = 'app'`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // packages/reader
const repo = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"]).toString().trim();
const rel = path.relative(repo, root); // packages/reader
const ponderDir = realpathSync(path.join(root, "node_modules", "ponder"));
const req = createRequire(path.join(ponderDir, "package.json"));
const { glob } = req("glob");
const superjson = req("superjson").default ?? req("superjson");
const vite = await import(req.resolve("vite"));

const revs = process.argv.slice(2);
if (revs.length === 0) throw new Error("usage: node scripts/bid.mjs <rev>...");

const server = await vite.createServer({ root, logLevel: "silent", server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
const cfg = (await server.ssrLoadModule(path.join(root, "ponder.config.ts"))).default;
await server.close();
const configHash = createHash("sha256").update(superjson.stringify({ ordering: cfg.ordering, contracts: cfg.contracts, accounts: cfg.accounts, blocks: cfg.blocks })).digest("hex");
const workingConfig = readFileSync(path.join(root, "ponder.config.ts"), "utf8");
console.log(`configHash ${configHash.slice(0, 16)}… (working tree, contracts=${Object.keys(cfg.contracts).length})`);

for (const rev of revs) {
  const tmp = mkdtempSync(path.join(tmpdir(), "bid-"));
  try {
    const tar = execFileSync("git", ["-C", repo, "archive", rev, `${rel}/src`, `${rel}/ponder.schema.ts`, `${rel}/ponder.config.ts`], { maxBuffer: 1 << 28 });
    execFileSync("tar", ["-x", "-C", tmp], { input: tar });
    const r = path.join(tmp, rel);
    const configDiffers = readFileSync(path.join(r, "ponder.config.ts"), "utf8") !== workingConfig;
    const schemaHash = createHash("sha256").update(readFileSync(path.join(r, "ponder.schema.ts"), "utf-8")).digest("hex");
    const files = glob.sync(path.join(r, "src", "**/*.{js,mjs,ts,mts}"), {
      ignore: [path.join(r, "src/api", "**/*.{js,mjs,ts,mts}"), path.join(r, "src", "**/*.{test,spec}.{js,mjs,ts,mts}")],
    });
    const h = createHash("sha256");
    for (const f of files) h.update(readFileSync(f, "utf-8"));
    const indexingHash = h.digest("hex");
    const buildId = createHash("sha256").update("2").update(configHash).update(schemaHash).update(indexingHash).digest("hex").slice(0, 10);
    console.log(`${rev} files ${files.length} schema ${schemaHash.slice(0, 12)} indexing ${indexingHash.slice(0, 12)} buildId ${buildId}${configDiffers ? " (ponder.config.ts differs from the working tree: configHash not this revision's)" : ""}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
