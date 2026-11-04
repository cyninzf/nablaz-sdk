// Row C: the startup RPC check (src/rpc-check.ts). scripts/reader-start.sh runs it before Ponder starts; a leg
// that does not answer stops the start, and the log names that leg. Prints hosts only.
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
if (failed.length) {
  console.error(`rpc check: ${failed.length} of ${results.length} legs failed: ${failed.map((r) => r.env).join(", ")}`);
  process.exit(1);
}
