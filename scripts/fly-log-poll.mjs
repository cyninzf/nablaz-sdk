#!/usr/bin/env node
// The log-capture form of record (R-S221-6): poll `flyctl logs --no-tail` every 5 s and append each line not seen
// before, deduplicated by the full line. It replaces a streaming `flyctl logs`, which stalled silently in S221: the
// process stayed alive and delivered nothing while --no-tail showed new lines. --no-tail returns the last 100 lines,
// about 10 s while Ponder indexes, so a 5 s poll keeps a margin of about 2x.
//
//   node scripts/fly-log-poll.mjs <out-dir>        (keep <out-dir> outside /tmp: Codespace /tmp does not survive)
//
// Writes, appending, so a restart of this script resumes without duplicates:
//   <out-dir>/log.txt     every line except the front's caller lines, URLs masked;
//   <out-dir>/caller.log  the front's `caller {...}` lines (P-GTM-4), unmasked: the user-agent must stay exact for
//                         the UA config (R-S217-7, R-S221-1), and the line carries no IP by design.
// Dedupe keys: caller lines from caller.log only, others from log.txt only, so a caller line that an earlier capture
// wrote (masked or not) into log.txt is still captured.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/fly-log-poll.mjs <out-dir>");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const CALLER = join(dir, "caller.log");
const LOG = join(dir, "log.txt");
const FLYCTL = join(homedir(), ".fly/bin/flyctl");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const mask = (s) => s.replace(/(postgres(ql)?|https?|wss?):\/\/[^" ]+/g, "[url]");
const isCaller = (s) => s.includes("caller {");
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").map(strip).filter(Boolean) : []);

const seen = new Set();
for (const l of lines(CALLER)) seen.add(l);
for (const l of lines(LOG)) if (!isCaller(l)) seen.add(l);

const tick = () =>
  execFile(FLYCTL, ["logs", "-a", "nablaz-reader", "--no-tail"], { maxBuffer: 1 << 24, timeout: 60_000 }, (err, out) => {
    if (err) console.error(new Date().toISOString(), "poll error", String(err.message).slice(0, 120));
    for (const raw of strip(out ?? "").split("\n")) {
      if (!raw.trim()) continue;
      const key = isCaller(raw) ? raw : mask(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      appendFileSync(isCaller(raw) ? CALLER : LOG, key + "\n");
    }
    setTimeout(tick, 5_000);
  });
tick();
