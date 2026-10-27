// Generates src/generated/enforcers.json from MetaMask/delegation-framework documents/Deployments.md at the
// pinned commit (R-S189-7). test/unit/enforcers.test.ts regenerates and diffs (R-S189-8 (i)).
//
//   node --experimental-strip-types scripts/gen-enforcers.ts

import { writeFileSync } from "node:fs";
import { DEPLOYMENTS_URL, buildEnforcerTable, serializeEnforcerTable } from "../src/enforcer-table.ts";

const res = await fetch(DEPLOYMENTS_URL);
if (!res.ok) throw new Error(`fetch ${DEPLOYMENTS_URL}: ${res.status}`);
const table = buildEnforcerTable(await res.text());
writeFileSync(new URL("../src/generated/enforcers.json", import.meta.url), serializeEnforcerTable(table));
const count = (k: string) => table.rows.filter((r) => r.class === k).length;
console.log(
  `${table.rows.length} rows: amount ${count("amount")}, exact-call ${count("exact-call")}, call-term ${count("call-term")}, scope-only ${count("scope-only")}, wrapper ${count("wrapper")}`,
);
