#!/usr/bin/env node
// S233 Task 1: total record size and growth rate, measured on the reader's own tables (R-S232-8: design for the
// rate, not today's size). Re-runnable; the committed figures are in s233-record-size.md beside it.
//
//   node docs/measurements/s233-record-size.mjs            from the repo root: runs itself in a throwaway Fly console
//                                                          (the scripts/explain.mjs form), then lists machines and
//                                                          fails unless exactly ONE remains.
//   node docs/measurements/s233-record-size.mjs --inside   inside the console (the app's DATABASE_URL): prints figures.
//
// Method: SQL on the live deployment schema (read from the `reader` views, as scripts/explain.mjs), in ONE
// transaction opened READ ONLY at REPEATABLE READ, so every figure is from the same snapshot and nothing can be
// written. Every onchain table of packages/reader/ponder.schema.ts is counted (exact count(*), not reltuples), per
// chain and per sub-kind where the table carries one (record_entries.kind_name, the source/kind/role/event columns).
// Growth: rows per UTC calendar month by block_timestamp (the fact's own chain time, not the time it was indexed),
// rows in the last 7 and 30 days, and each table's indexed span (min/max block_timestamp). Sizes:
// pg_total_relation_size per table (heap + indexes + toast) and the schema total.
// Feed kinds (src/api/feed.ts): account = record_entries ACCOUNT_OPENED; grant = record_entries GRANT_SET +
// external_permissions; payment = vault_payments + external_payments.

import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "nablaz-reader";

// Every onchain table, with the column that splits it into sub-kinds (null: none).
const TABLES = [
  ["record_entries", "kind_name"],
  ["obligation_pairs", "role"],
  ["consent_events", "event"],
  ["accounts", null],
  ["grants", null],
  ["vaults", null],
  ["vault_fundings", null],
  ["vault_payments", null],
  ["implementation_history", "source"],
  ["counterparties", null],
  ["factory_accounts", null],
  ["external_permissions", "source"],
  ["external_payments", "source"],
  ["external_redemptions", "hop"],
  ["credit_line_events", "kind"],
  ["feedbacks", null],
  ["agent_wallets", null],
  ["agent_owners", null],
];

// Feed kind of a (table, sub-kind) row group, or null when the feed does not carry it.
const feedKind = (table, k) =>
  table === "record_entries" ? (k === "ACCOUNT_OPENED" ? "account" : k === "GRANT_SET" ? "grant" : null)
  : table === "external_permissions" ? "grant"
  : table === "vault_payments" || table === "external_payments" ? "payment"
  : null;

if (process.argv[2] === "--inside") await inside();
else await outside();

async function outside() {
  const flyctl = path.join(homedir(), ".fly/bin/flyctl");
  const self = fileURLToPath(import.meta.url);
  console.log(`record-size: throwaway console on ${APP} (shared-cpu-1x, 1024 MB) at ${new Date().toISOString()}`);
  // Streamed, line by line, URLs masked (the console prints none, but mask anyway). No client-side timeout: cutting the
  // session leaves the console machine running (S233: it had to be destroyed by hand), so let it finish.
  const child = spawn(flyctl, ["console", "-a", APP, "--vm-size", "shared-cpu-1x", "--vm-memory", "1024", "--file-local", `/tmp/size.mjs=${self}`, "-C", "node /tmp/size.mjs --inside"], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.on("data", (b) => process.stdout.write(b.toString().replace(/(postgres(ql)?|https?|wss?):\/\/[^"\s]+/g, "[url]")));
  await new Promise((r) => child.on("close", r));
  const machines = JSON.parse(execFileSync(flyctl, ["machines", "list", "-a", APP, "--json"]).toString());
  console.log(`machines after console: ${machines.length} (${machines.map((m) => `${m.id} ${m.state}`).join(", ")})`);
  if (machines.length !== 1) {
    console.error("record-size: expected exactly ONE machine after the console; STOP and report");
    process.exit(3);
  }
}

async function inside() {
  const pnpm = "/app/node_modules/.pnpm";
  const pgDir = readdirSync(pnpm).find((d) => /^pg@\d/.test(d));
  if (!pgDir) throw new Error("pg not found under /app/node_modules/.pnpm");
  const { Client } = (await import(path.join(pnpm, pgDir, "node_modules/pg/lib/index.js"))).default;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const q = async (sql) => (await c.query(sql)).rows;
  try {
    await c.query("begin isolation level repeatable read read only");
    await c.query("set local statement_timeout = '600s'");
    const def = (await q(`select definition from pg_views where schemaname = 'reader' limit 1`))[0]?.definition ?? "";
    const schema = /FROM\s+"?([A-Za-z0-9_-]+)"?\./i.exec(def)?.[1];
    if (!schema) throw new Error("live schema not found in the reader views");
    const [{ now }] = await q(`select extract(epoch from now())::bigint as now`);
    const nowS = Number(now);
    console.log(`at ${new Date(nowS * 1000).toISOString()} live schema ${schema} (snapshot: one read-only repeatable-read transaction)`);

    // One scan per table: grouped by chain, sub-kind and UTC month (month from integer arithmetic on the epoch:
    // days since 1970 → civil date is done in JS, so the database does only integer division per row).
    const groups = []; // { table, chain, k, n, min, max, d7, d30 }
    const months = new Map(); // `${month}\u0000${table}\u0000${k}` -> n
    for (const [table, col] of TABLES) {
      const k = col ? `coalesce(${col}::text, '(null)')` : `''`;
      const t = `"${schema}".${table}`;
      const [{ est }] = await q(`select reltuples::bigint as est from pg_class where oid = '${t}'::regclass`);
      const t0 = Date.now();
      const rows = await q(
        `select chain_id, ${k} as k, (block_timestamp / 86400)::bigint as day, count(*)::bigint as n,
                min(block_timestamp)::bigint as min, max(block_timestamp)::bigint as max
           from ${t} group by 1, 2, 3`,
      );
      const byGroup = new Map();
      for (const r of rows) {
        const key = `${r.chain_id}\u0000${r.k}`;
        const g = byGroup.get(key) ?? { table, chain: r.chain_id, k: r.k, n: 0, min: Infinity, max: -Infinity, d7: 0, d30: 0 };
        const n = Number(r.n);
        const daySecs = Number(r.day) * 86400;
        g.n += n;
        g.min = Math.min(g.min, Number(r.min));
        g.max = Math.max(g.max, Number(r.max));
        // Day buckets: a day counts toward the last 7 / 30 days when it starts at or after the cut's day.
        if (daySecs >= Math.floor((nowS - 7 * 86400) / 86400) * 86400) g.d7 += n;
        if (daySecs >= Math.floor((nowS - 30 * 86400) / 86400) * 86400) g.d30 += n;
        byGroup.set(key, g);
        const m = new Date(daySecs * 1000).toISOString().slice(0, 7);
        const mk = `${m}\u0000${table}\u0000${r.k}`;
        months.set(mk, (months.get(mk) ?? 0) + n);
      }
      groups.push(...[...byGroup.values()].sort((a, b) => a.chain - b.chain || String(a.k).localeCompare(String(b.k))));
      console.log(`scanned ${table} (~${est} rows est.) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    const sizes = await q(
      `select c.relname as table, pg_total_relation_size(c.oid)::bigint as bytes from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = '${schema}' and c.relkind = 'r' order by 2 desc`,
    );
    await c.query("rollback");

    const iso = (s) => (Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString().slice(0, 10) : "-");
    const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
    const total = sum(groups, (g) => g.n);

    console.log(`\n== facts per table, sub-kind and chain (rows; span = min..max block_timestamp, UTC dates; last 7 / 30 d = whole UTC days from the cut's day)`);
    for (const g of groups) console.log(`   ${g.table.padEnd(23)} ${String(g.k || "-").padEnd(26)} ${String(g.chain).padStart(6)} ${String(g.n).padStart(10)}  ${iso(g.min)}..${iso(g.max)}  7d ${g.d7}  30d ${g.d30}`);

    console.log(`\n== per table (all chains)`);
    for (const [table] of TABLES) {
      const gs = groups.filter((g) => g.table === table);
      console.log(`   ${table.padEnd(23)} ${String(sum(gs, (g) => g.n)).padStart(10)}  7d ${sum(gs, (g) => g.d7)}  30d ${sum(gs, (g) => g.d30)}`);
    }

    console.log(`\n== per chain (all tables)`);
    for (const chain of [...new Set(groups.map((g) => g.chain))].sort((a, b) => a - b)) {
      const gs = groups.filter((g) => g.chain === chain);
      const lo = Math.min(...gs.map((g) => g.min));
      const hi = Math.max(...gs.map((g) => g.max));
      const days = (hi - lo) / 86400;
      const n = sum(gs, (g) => g.n);
      console.log(`   ${String(chain).padStart(6)} ${String(n).padStart(10)}  span ${iso(lo)}..${iso(hi)} (${days.toFixed(1)} d)  mean ${(n / Math.max(days, 1)).toFixed(1)}/d  7d ${sum(gs, (g) => g.d7)} (${(sum(gs, (g) => g.d7) / 7).toFixed(1)}/d)  30d ${sum(gs, (g) => g.d30)} (${(sum(gs, (g) => g.d30) / 30).toFixed(1)}/d)`);
    }

    console.log(`\n== feed kinds (what GET /feed pages through), per chain`);
    const fk = groups.filter((g) => feedKind(g.table, g.k));
    for (const kind of ["account", "grant", "payment"]) {
      const gs = fk.filter((g) => feedKind(g.table, g.k) === kind);
      const per = [...new Set(gs.map((g) => g.chain))].sort((a, b) => a - b).map((ch) => `${ch}:${sum(gs.filter((g) => g.chain === ch), (g) => g.n)}`);
      console.log(`   ${kind.padEnd(8)} ${String(sum(gs, (g) => g.n)).padStart(10)}  7d ${sum(gs, (g) => g.d7)}  30d ${sum(gs, (g) => g.d30)}  [${per.join(" ")}]`);
    }
    const feedTotal = sum(fk, (g) => g.n);
    console.log(`   ${"feed".padEnd(8)} ${String(feedTotal).padStart(10)}  7d ${sum(fk, (g) => g.d7)} (${(sum(fk, (g) => g.d7) / 7).toFixed(1)}/d)  30d ${sum(fk, (g) => g.d30)} (${(sum(fk, (g) => g.d30) / 30).toFixed(1)}/d)`);

    console.log(`\n== rows per UTC month by block_timestamp: all tables | feed items (account grant payment)`);
    const ms = [...new Set([...months.keys()].map((k) => k.split("\u0000")[0]))].sort();
    for (const m of ms) {
      let all = 0;
      const f = { account: 0, grant: 0, payment: 0 };
      for (const [key, n] of months) {
        const [mm, table, k] = key.split("\u0000");
        if (mm !== m) continue;
        all += n;
        const kind = feedKind(table, k);
        if (kind) f[kind] += n;
      }
      console.log(`   ${m}  ${String(all).padStart(10)} | ${String(f.account + f.grant + f.payment).padStart(9)} (${f.account} ${f.grant} ${f.payment})`);
    }

    console.log(`\n== on-disk size (pg_total_relation_size: heap + indexes + toast)`);
    const mine = new Set(TABLES.map(([t]) => t));
    for (const s of sizes.filter((s) => mine.has(s.table))) console.log(`   ${s.table.padEnd(23)} ${(Number(s.bytes) / 2 ** 20).toFixed(1).padStart(9)} MiB`);
    const fact = sum(sizes.filter((s) => mine.has(s.table)), (s) => Number(s.bytes));
    const all = sum(sizes, (s) => Number(s.bytes));
    console.log(`   fact tables ${(fact / 2 ** 20).toFixed(1)} MiB; whole schema (Ponder's reorg/meta tables included) ${(all / 2 ** 20).toFixed(1)} MiB`);
    console.log(`\ntotal facts ${total} (all tables, all chains); feed items ${feedTotal}`);
  } finally {
    await c.end();
  }
}
