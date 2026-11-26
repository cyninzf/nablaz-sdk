#!/usr/bin/env node
// The GET /feed EXPLAIN gate (schema event step 5, R-S217-1), committed so a cold reboot restages it in one command.
//
//   node scripts/explain.mjs                 from the repo root: runs itself in a throwaway Fly console (R-S194-7
//                                            form), then lists machines and fails unless exactly ONE remains.
//   node scripts/explain.mjs --inside        inside the console (the app's DATABASE_URL): prints the plans.
//
// Inside, it reads the live deployment schema from the `reader` views, the row estimate of each of GET /feed's four
// tables (pg_class.reltuples, no scan), and plain EXPLAIN (never ANALYZE) of each table's first-page query, in the
// shape src/api/index.ts issues: the per-chain asOf window, ORDER BY the feed key descending, LIMIT 100 + 3. The
// asOf bound is a block number above every chain's head, so every row qualifies, as at the head.
//
// Verdict (R-S217-1): a table of 1M rows or more must be read through its `*_feed` index: PASS, else FAIL. A Seq
// Scan on a table that fits in about one page of the feed is the planner's cost choice, reported as NOTE, not FAIL.
// R-S226-4: then the any-hash door's lookup on each table it searches (src/api/tx.ts TX_SEARCHED), for EVERY chain in
// CHAINS (S228: until then only CHAINS[0] was planned, so 8453 and 137 went unchecked), in the shape
// src/api/index.ts issues (chain_id = N and tx_hash = H, a synthetic hash): a table of 1M rows or more must be read
// through its `*_tx` index, under the same verdict rule. Both sets gate: NABLAZ_TX stays off on any FAIL.
// Exit 0 on PASS, 1 on any FAIL. Nothing is written to the database.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "nablaz-reader";
const CHAINS = [42161, 8453, 137, 10, 59144];
const LIMIT = 100 + 3; // FEED_DEFAULT_LIMIT + the 3 rows src/api/index.ts adds for cursor ties
const BIG_TABLE = 1_000_000;
const TABLES = [
  { table: "record_entries", extra: `and kind_name in ('ACCOUNT_OPENED','GRANT_SET')` }, // FEED_RECORD_KINDS
  { table: "external_permissions", extra: "" },
  { table: "vault_payments", extra: "" },
  { table: "external_payments", extra: "" },
];

// The any-hash door's tables (R-S226-4; the six of src/api/tx.ts TX_SEARCHED) and the hash its plans use.
const TX_TABLES = ["record_entries", "vault_payments", "external_permissions", "external_payments", "external_redemptions", "credit_line_events"];
const TX_PROBE = `0x${"ab".repeat(32)}`;

if (process.argv[2] === "--inside") await inside();
else outside();

function outside() {
  const flyctl = path.join(homedir(), ".fly/bin/flyctl");
  const self = fileURLToPath(import.meta.url);
  console.log(`explain: throwaway console on ${APP} (shared-cpu-1x, 1024 MB) at ${new Date().toISOString()}`);
  const out = execFileSync(
    flyctl,
    ["console", "-a", APP, "--vm-size", "shared-cpu-1x", "--vm-memory", "1024", "--file-local", `/tmp/explain.mjs=${self}`, "-C", "node /tmp/explain.mjs --inside"],
    { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 24 },
  ).toString();
  // URLs never reach the terminal (the console prints none, but mask anyway).
  process.stdout.write(out.replace(/(postgres(ql)?|https?|wss?):\/\/[^"\s]+/g, "[url]"));
  const machines = JSON.parse(execFileSync(flyctl, ["machines", "list", "-a", APP, "--json"]).toString());
  console.log(`machines after console: ${machines.length} (${machines.map((m) => `${m.id} ${m.state}`).join(", ")})`);
  if (machines.length !== 1) {
    console.error("explain: expected exactly ONE machine after the console; STOP and report");
    process.exit(3);
  }
  if (!/^verdict PASS/m.test(out)) process.exit(1);
}

async function inside() {
  const pnpm = "/app/node_modules/.pnpm";
  const pgDir = readdirSync(pnpm).find((d) => /^pg@\d/.test(d));
  if (!pgDir) throw new Error("pg not found under /app/node_modules/.pnpm");
  const { Client } = (await import(path.join(pnpm, pgDir, "node_modules/pg/lib/index.js"))).default;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const def = (await c.query(`select definition from pg_views where schemaname = 'reader' limit 1`)).rows[0]?.definition ?? "";
    const schema = /FROM\s+"?([A-Za-z0-9_-]+)"?\./i.exec(def)?.[1];
    if (!schema) throw new Error("live schema not found in the reader views");
    console.log(`at ${new Date().toISOString()} live schema ${schema}`);
    const window = CHAINS.map((id) => `(chain_id = ${id} and block_number <= 999999999999::numeric(78))`).join(" or ");
    let fail = 0;
    for (const { table, extra } of TABLES) {
      const rows = Number((await c.query(`select reltuples::bigint as n from pg_class where oid = $1::regclass`, [`"${schema}".${table}`])).rows[0].n);
      const sql = `select * from "${schema}".${table} where (${window}) ${extra} order by block_timestamp desc, chain_id desc, block_number desc, log_index desc limit ${LIMIT}`;
      const plan = (await c.query(`explain ${sql}`)).rows.map((r) => r["QUERY PLAN"]);
      const feed = plan.some((l) => l.includes(`${table}_feed`));
      const seq = plan.some((l) => /Seq Scan/.test(l));
      const verdict = feed ? "PASS" : rows >= BIG_TABLE ? "FAIL" : seq ? "NOTE (one-page Seq Scan = planner cost, R-S217-1)" : "NOTE";
      if (verdict === "FAIL") fail++;
      console.log(`\n== ${table}  ~${rows} rows  ${verdict}`);
      for (const l of plan) console.log(`   ${l}`);
    }
    for (const chain of CHAINS) for (const table of TX_TABLES) {
      const rows = Number((await c.query(`select reltuples::bigint as n from pg_class where oid = $1::regclass`, [`"${schema}".${table}`])).rows[0].n);
      const sql = `select * from "${schema}".${table} where chain_id = ${chain} and tx_hash = '${TX_PROBE}'`;
      const plan = (await c.query(`explain ${sql}`)).rows.map((r) => r["QUERY PLAN"]);
      const ix = plan.some((l) => l.includes(`${table}_tx`));
      const seq = plan.some((l) => /Seq Scan/.test(l));
      const verdict = ix ? "PASS" : rows >= BIG_TABLE ? "FAIL" : seq ? "NOTE (small-table Seq Scan = planner cost, R-S217-1)" : "NOTE";
      if (verdict === "FAIL") fail++;
      console.log(`\n== tx chain ${chain} ${table}  ~${rows} rows  ${verdict}`);
      for (const l of plan) console.log(`   ${l}`);
    }
    console.log(`\nverdict ${fail ? `FAIL (${fail} table(s) of >= ${BIG_TABLE} rows off their *_feed or *_tx index)` : "PASS"}`);
  } finally {
    await c.end();
  }
}
