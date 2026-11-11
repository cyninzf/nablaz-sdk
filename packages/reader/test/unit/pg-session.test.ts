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

// S213 B3: Ponder's readonly pool (the API's /read and /feed queries) runs SET work_mem = '512MB' after connecting,
// which overrode the 16MB above for that pool. patches/ponder@0.18.6.patch sets it to 16MB. The patch is pinned to
// 0.18.6: this test fails on any other Ponder version, so an upgrade re-proves the patch before it ships.
describe("readonly pool work_mem (S213 B3, patches/ponder@0.18.6.patch)", () => {
  it("the installed Ponder is 0.18.6, and its readonly pool sets work_mem 16MB on connect, never 512MB", async () => {
    const { realpathSync, readFileSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const path = await import("node:path");
    const dir = realpathSync(new URL("../../node_modules/ponder", import.meta.url));
    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version).toBe("0.18.6");
    const pg = createRequire(path.join(dir, "package.json"))("pg");
    const sent: string[] = [];
    const connect = vi.spyOn(pg.Client.prototype, "connect").mockImplementation(function (cb?: (e?: Error) => void) {
      return cb ? void cb() : Promise.resolve();
    } as never);
    const query = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (sql: string, cb?: (e?: Error) => void) {
      sent.push(String(sql));
      return cb ? void cb() : Promise.resolve({ rows: [] });
    } as never);
    try {
      const { createReadonlyPool } = await import(pathToFileURL(path.join(dir, "dist/esm/utils/pg.js")).href);
      const logger = { warn() {}, error() {}, info() {}, debug() {}, trace() {} };
      const pool = createReadonlyPool({ max: 1 }, logger, "reader");
      const client = await pool.connect();
      client.release();
      await pool.end();
      const setup = sent.join("\n");
      expect(setup).toContain("SET work_mem = '16MB';");
      expect(setup).not.toContain("512MB");
      expect(setup).toContain("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;");
    } finally {
      connect.mockRestore();
      query.mockRestore();
    }
  });
});
