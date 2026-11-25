// R-S231-8 guard: the tx-door subject (src/api/tx.ts) is API-layer work and must not move Ponder's build id. The id
// is recomputed by scripts/bid.mjs from the committed revision HEAD (in CI, the tree under test), and must equal the
// id the S230 five-chain reindex runs under: fe32cfae51 at 79b09b4. A change that moves it on purpose (indexing src,
// ponder.schema.ts, or the evaluated ponder.config.ts) is a full reindex, and updates this pin in the same PR.

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CHAINS } from "../../src/chains";

const PINNED = "fe32cfae51";

describe("Ponder build id", () => {
  it(`HEAD still hashes to ${PINNED} (the live reindex's id)`, () => {
    // Every RPC name must be set for ponder.config.ts to evaluate; the values are not hashed.
    const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME ?? "" };
    for (const c of Object.values(CHAINS)) env[c.rpcEnv] = env[c.groundingRpcEnv] = "http://127.0.0.1:1";
    const out = execFileSync("node", ["scripts/bid.mjs", "HEAD"], { cwd: new URL("../..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] }).toString();
    expect(out.match(/^HEAD .* buildId ([0-9a-f]{10})/m)?.[1]).toBe(PINNED);
  });
});
