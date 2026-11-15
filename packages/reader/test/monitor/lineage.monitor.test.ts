// Live-state MONITOR, not a merge gate (R-S221-3; standing lock S190: "a test reading live market state is a monitor,
// not a merge gate"). It reads ProtocolConfig.currentAccountImpl() at the chain head, so its answer changes when the
// chain does, not when this repository does. CI runs it in its own job, `live-state monitor`, which reports a
// divergence as a warning annotation and in the job summary and never fails the run (.github/workflows/ci.yml).
// Moved from test/fork/external.fork.test.ts unchanged in substance. The lineage data itself (src/labels.ts) moves only
// with the sdk G1 schema bundle (R-S221-4).

import { describe, expect, it } from "vitest";
import { createPublicClient, http, parseAbi } from "viem";
import { CHAINS, CURRENT_ACCOUNT_IMPL_LINEAGE, PROTOCOL_CONFIG } from "../../src/chains";

// The env name comes from its one home, src/chains.ts (CI's env-names guard).
const ARB_RPC_ENV = CHAINS[42161]!.rpcEnv;
const UPSTREAM = process.env[ARB_RPC_ENV];

describe("NablaZ canonical lineage (live-state monitor)", () => {
  it("the lineage tip is ProtocolConfig.currentAccountImpl()", async () => {
    if (!UPSTREAM) throw new Error(`${ARB_RPC_ENV} is not set: the monitor reads Arbitrum One and does not skip`);
    const c = createPublicClient({ transport: http(UPSTREAM) });
    const current = await c.readContract({
      address: PROTOCOL_CONFIG,
      abi: parseAbi(["function currentAccountImpl() view returns (address)"]),
      functionName: "currentAccountImpl",
    });
    expect(current, `live currentAccountImpl ${current} is not the lineage tip ${CURRENT_ACCOUNT_IMPL_LINEAGE.at(-1)}`).toBe(CURRENT_ACCOUNT_IMPL_LINEAGE.at(-1));
  });
});
