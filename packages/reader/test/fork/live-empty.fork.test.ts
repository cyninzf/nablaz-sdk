// Empty state against the live chain: from the deployment blocks to a finalized block near head. Today
// there are no accounts on the permanent stack, so every table must come back empty and nothing errors.

import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { TABLES, UPSTREAM, indexOnce } from "./harness";

describe("live chain, empty state", () => {
  it("runs clean and returns empty tables", async () => {
    const client = createPublicClient({ transport: http(UPSTREAM) });
    const head = Number(await client.request({ method: "eth_blockNumber" }));
    const run = await indexOnce({ rpcUrl: UPSTREAM!, endBlock: head - 2_000 });
    for (const name of TABLES) expect(run.tables[name], name).toEqual([]);
  });
});
