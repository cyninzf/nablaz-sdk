// R-S212-4: on Postgres, every connection Ponder opens carries the session memory settings as a startup parameter,
// set in ponder.config.ts; PGlite gets none. Ponder 0.18.6 spreads database.poolConfig into all four of its pools
// (database/index.ts) and pg sends `options` at connect (pg/lib/connection-parameters.js).

import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAINS } from "../../src/chains.ts";

const OPTIONS = "-c maintenance_work_mem=32MB -c max_parallel_maintenance_workers=0 -c work_mem=16MB";
const RPC_ENVS = Object.values(CHAINS).flatMap((c) => [c.rpcEnv, c.groundingRpcEnv]);

async function loadConfig(env: Record<string, string | undefined>) {
  for (const k of RPC_ENVS) vi.stubEnv(k, "http://127.0.0.1:1");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  vi.resetModules();
  return (await import("../../ponder.config.ts")).default as { database: Record<string, unknown> };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session memory settings (R-S212-4)", () => {
  it("Postgres: the pool's startup options carry the three settings, and nothing else in poolConfig", async () => {
    const cfg = await loadConfig({ DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" });
    expect(cfg.database).toEqual({ kind: "postgres", poolConfig: { options: OPTIONS } });
  });

  it("PGlite: no poolConfig", async () => {
    const cfg = await loadConfig({ DATABASE_URL: "", READER_PGLITE_DIR: "/tmp/x" });
    expect(cfg.database).toEqual({ kind: "pglite", directory: "/tmp/x" });
  });
});
