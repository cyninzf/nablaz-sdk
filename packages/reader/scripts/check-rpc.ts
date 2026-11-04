// Row C: the startup RPC check (src/rpc-check.ts). scripts/reader-start.sh runs it before Ponder starts; a leg
// that does not answer is named in a warning and the start goes on (exit 0). Prints hosts only.
//   node --experimental-strip-types packages/reader/scripts/check-rpc.ts

import { enabledChains } from "../src/chains.ts";
import { checkRpcLegs, formatLegCheck } from "../src/rpc-check.ts";

// Up to ATTEMPTS rounds, PAUSE_MS apart, so one dropped call at boot does not stop the start; every round is logged.
const ATTEMPTS = 3;
const PAUSE_MS = 5_000;
let results = await checkRpcLegs(enabledChains());
for (let i = 1; ; i++) {
  for (const r of results) console.error(`${formatLegCheck(r)} (round ${i} of ${ATTEMPTS})`);
  if (results.every((r) => r.ok) || i === ATTEMPTS) break;
  await new Promise((r) => setTimeout(r, PAUSE_MS));
  results = await checkRpcLegs(enabledChains());
}
const failed = results.filter((r) => !r.ok);
// Warn and start (CTO ruling, S200): a boot-blocking check would restart-loop the machine on any vendor outage
// (the Oct 30 exit-75 class); Ponder's fallback and /metrics/reader carry an ongoing leg failure from here.
if (failed.length) console.error(`rpc check WARNING: ${failed.length} of ${results.length} legs failed: ${failed.map((r) => r.env).join(", ")}; starting anyway`);
