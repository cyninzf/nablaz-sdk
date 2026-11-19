#!/usr/bin/env node
// The spend/limit detector, standing form (S224): a log line is a hit ONLY when an HTTP status 402 or 429 is
// written as a status, in one of three shapes: `status=402`, `HTTP 429`, `code 429` (also `code=`/`code:`).
// A bare 402 or 429 anywhere else (a block number, a hash, a byte count, a duration, a JSON-RPC error code such as
// -32005 or 429xx) is not a hit. 402 is the provider's payment/spend refusal, 429 its rate limit; nothing else.
//
//   node scripts/rpc-limit-detector.mjs <log.txt>...   prints each hit, exit 1 if any, 0 if none
//   node scripts/rpc-limit-detector.mjs --self-test    the red and green fixtures below; CI runs it
//
// Lines are already URL-masked by scripts/fly-log-poll.mjs; this script prints them as read.

import { readFileSync } from "node:fs";

export const LIMIT_RE = /(?:\bstatus=|\bHTTP |\bcode[ =:]\s*)(402|429)(?!\d)/;
export const isLimitLine = (line) => LIMIT_RE.test(line);

// Red: each MUST be a hit. Green: each must NOT be.
const RED = [
  "[rpc arbitrum grounding] HTTP request failed. status=429 url=[redacted:grounding]",
  "[rpc polygon indexer] HTTP request failed. status=402 body=payment required",
  "rpc check FAILED: READER_X (base grounding, host x.example): HTTP 429",
  "front relay /feed status=429 (rate limit)",
  "[rpc base indexer] error code 429 Too Many Requests",
  "[rpc base indexer] error code=402 monthly capacity exceeded",
];
const GREEN = [
  "Indexed block chain=arbitrum number=429402429",
  "Indexed block chain=polygon number=74291402",
  "tx 0x429402deadbeef status=200",
  "HTTP 200 in 429 ms",
  "[rpc base indexer] error code -32005 limit exceeded",
  "status=4290 is not a status",
  "code 4021",
  "Created database indexes count=24 (22m 29s)",
];

if (process.argv[2] === "--self-test") {
  let bad = 0;
  for (const l of RED) if (!isLimitLine(l)) (bad++, console.error(`red fixture NOT flagged: ${l}`));
  for (const l of GREEN) if (isLimitLine(l)) (bad++, console.error(`green fixture flagged: ${l}`));
  console.log(bad ? `self-test FAILED (${bad})` : `self-test ok (${RED.length} red, ${GREEN.length} green)`);
  process.exit(bad ? 1 : 0);
} else if (process.argv.length > 2) {
  let hits = 0;
  for (const f of process.argv.slice(2))
    for (const l of readFileSync(f, "utf8").split("\n")) if (isLimitLine(l)) (hits++, console.log(`${f}: ${l}`));
  process.exit(hits ? 1 : 0);
} else {
  console.error("usage: node scripts/rpc-limit-detector.mjs <log.txt>... | --self-test");
  process.exit(2);
}
