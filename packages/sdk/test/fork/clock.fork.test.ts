// R-S198-1: the calendar class. A fork at FORK_BLOCK carries that block's timestamp; the official x402 client and
// facilitator read the wall clock. startAnvil(..., { alignToWallClock: true }) must hand back a fork whose clock
// is the wall clock, whatever the date the suite runs on.

import { afterAll, beforeAll, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";
import { FORK_BLOCK, startAnvil, type Anvil } from "./anvil.ts";

let anvil: Anvil;
beforeAll(async () => {
  anvil = await startAnvil(FORK_BLOCK, { alignToWallClock: true });
}, 120_000);
afterAll(async () => anvil?.stop());

it("an aligned fork's latest block is within 60 s of the wall clock", async () => {
  const pub = createPublicClient({ chain: arbitrum, transport: http(anvil.url) });
  const chain = Number((await pub.getBlock()).timestamp);
  const wall = Math.floor(Date.now() / 1000);
  expect(Math.abs(wall - chain), `fork clock ${chain}, wall clock ${wall}`).toBeLessThanOrEqual(60);
});
