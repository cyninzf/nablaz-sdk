#!/usr/bin/env node
// Public /ready edge watch (S224), a convenience beside the durable record: the Sentry uptime monitor on
// https://read.nablaz.io/ready (60 s, server-side) is the READY edge of record; this file is not load-bearing.
// Polls every 30 s with `x-nablaz-caller: watcher` (P-GTM-4) and appends to <out-dir>/ready.log one line per
// status CHANGE (and the first reading): ISO time, HTTP status (or the fetch error name). A restart resumes from
// the last line.
//
//   node scripts/ready-watch.mjs <out-dir>

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/ready-watch.mjs <out-dir>");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const LOG = join(dir, "ready.log");
let last = existsSync(LOG) ? (readFileSync(LOG, "utf8").trim().split("\n").at(-1) ?? "").split(" ")[1] : undefined;

async function tick() {
  let s;
  try {
    const r = await fetch("https://read.nablaz.io/ready", { headers: { "x-nablaz-caller": "watcher" }, signal: AbortSignal.timeout(20_000) });
    s = String(r.status);
  } catch (e) {
    s = `fetchfail:${e.name}`;
  }
  if (s !== last) appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
  last = s;
  setTimeout(tick, 30_000);
}
tick();
