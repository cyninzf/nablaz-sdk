// Empty state against the live chain: from the deployment blocks to 517860374, the block before the first
// account on the permanent stack (the S185 test account's ACCOUNT_OPENED at 517860375). Every table must come
// back empty and nothing errors.

import { describe, expect, it } from "vitest";
import { TABLES, UPSTREAM, indexOnce } from "./harness";

const LAST_EMPTY_BLOCK = 517_860_374;

describe("live chain, empty state", () => {
  it("runs clean and returns empty tables", async () => {
    const run = await indexOnce({ rpcUrl: UPSTREAM!, endBlock: LAST_EMPTY_BLOCK });
    for (const name of TABLES) expect(run.tables[name], name).toEqual([]);
  });
});
