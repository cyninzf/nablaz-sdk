// R-S214-5 (S213 A2): bindingAt skips ownerOf strictly before a known mint block and nowhere else.
import { describe, expect, it } from "vitest";
import { getAddress, type PublicClient } from "viem";
import { bindingAt } from "../../src/grounding-rpc";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const OWNER = getAddress("0x00000000000000000000000000000000000000aa");
const ZERO = "0x0000000000000000000000000000000000000000";

/** getAgentWallet answers `wallet`; ownerOf answers OWNER. Records the functions called. */
function client(wallet = ZERO) {
  const calls: string[] = [];
  const c = {
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      return functionName === "getAgentWallet" ? wallet : OWNER;
    },
  } as unknown as PublicClient;
  return { c, calls };
}

describe("bindingAt mint-block skip", () => {
  it("before the mint block: getAgentWallet only, binding none", async () => {
    const { c, calls } = client();
    expect(await bindingAt(c, REGISTRY, 7n, 99n, 100n)).toEqual({ kind: "none" });
    expect(calls).toEqual(["getAgentWallet"]);
  });
  it("at the mint block and after: ownerOf is read", async () => {
    for (const b of [100n, 101n]) {
      const { c, calls } = client();
      expect(await bindingAt(c, REGISTRY, 7n, b, 100n)).toEqual({ kind: "owner", address: OWNER });
      expect(calls).toEqual(["getAgentWallet", "ownerOf"]);
    }
  });
  it("unknown mint block (null or absent): ownerOf is read", async () => {
    for (const m of [null, undefined]) {
      const { c, calls } = client();
      expect(await bindingAt(c, REGISTRY, 7n, 5n, m)).toEqual({ kind: "owner", address: OWNER });
      expect(calls).toEqual(["getAgentWallet", "ownerOf"]);
    }
  });
  it("a wallet set is answered first, as before", async () => {
    const { c } = client(OWNER);
    expect(await bindingAt(c, REGISTRY, 7n, 5n, 100n)).toEqual({ kind: "agentWallet", address: OWNER });
  });
});
