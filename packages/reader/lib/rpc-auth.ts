// R-S211-1 (amends R-S200-2 narrowly): at startup, an AUTH-class failure (HTTP 401/403) on any configured RPC leg
// fails the start, naming the leg by its env name; every other failure keeps warn-and-start. An unauthenticated leg
// can never heal by waiting. Kept outside src/ so the rule does not move Ponder's build id (scripts/bid.mjs).

import type { LegCheck } from "../src/rpc-check.ts";

/** HTTP statuses that mean the provider refused the leg's credentials. */
export const AUTH_STATUSES = [401, 403] as const;

// src/rpc-check.ts reports a non-2xx answer as `<method>: HTTP <status>`; test/unit/rpc-auth.test.ts pins that shape.
const AUTH_DETAIL = new RegExp(`^eth_\\w+: HTTP (${AUTH_STATUSES.join("|")})$`);

/** The HTTP status when the leg failed with an auth-class refusal, else null. */
export function authStatus(r: LegCheck): number | null {
  if (r.ok || !r.detail) return null;
  const m = AUTH_DETAIL.exec(r.detail);
  return m ? Number(m[1]) : null;
}

/** The fatal line for the legs refused on credentials, or null when there is none (warn-and-start then applies). */
export function authFailureMessage(results: LegCheck[]): string | null {
  const refused = results.flatMap((r) => {
    const s = authStatus(r);
    return s === null ? [] : [`${r.env} (${r.chain} ${r.leg}, host ${r.host}): HTTP ${s}`];
  });
  if (!refused.length) return null;
  return `rpc check FATAL (R-S211-1): ${refused.length} leg(s) refused authentication: ${refused.join("; ")}. An unauthenticated leg cannot heal by waiting; fix the key and restart.`;
}
