// Row O (CTO ruling, S200): bindingAt classifies an ownerOf failure from its content. The ERC721NonexistentToken
// revert (selector 0x7e273289) reads as "none"; any other failure is rethrown unchanged. A viem error carries the
// call's args (BigInt agentId), so classifying it must not throw "Do not know how to serialize a BigInt" and hide
// the real error (CI run 41876911457, afg.fork.test.ts).

import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import { bindingAt } from "../../src/grounding-rpc";

const REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

/** getAgentWallet answers the zero address (no wallet); ownerOf throws `err`. */
const clientThrowing = (err: unknown) =>
  ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getAgentWallet") return ZERO;
      throw err;
    },
  }) as unknown as PublicClient;

describe("bindingAt (row O)", () => {
  it("a non-revert ownerOf error carrying a BigInt arg is rethrown unchanged, never a TypeError", async () => {
    const err = Object.assign(new Error("[rpc base grounding] HTTP request failed. Status: 429"), { args: [7n], blockNumber: 123n });
    const thrown = await bindingAt(clientThrowing(err), REGISTRY, 7n, 123n).catch((e: unknown) => e);
    expect(thrown).toBe(err);
  });

  it("the ERC721NonexistentToken revert (0x7e273289) still reads as none, in the message or in another field", async () => {
    expect(await bindingAt(clientThrowing(new Error("reverted with 0x7e273289000000")), REGISTRY, 7n, 1n)).toEqual({ kind: "none" });
    const inData = Object.assign(new Error("execution reverted"), { args: [7n], data: "0x7e2732890000000000000000000000000000000000000000000000000000000000000007" });
    expect(await bindingAt(clientThrowing(inData), REGISTRY, 7n, 1n)).toEqual({ kind: "none" });
  });
});
