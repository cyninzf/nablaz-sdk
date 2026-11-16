// β actorIdentity (S222): R-S191-16 binding at the payment's own block, from the indexed wallet and owner histories.

import { describe, expect, it } from "vitest";
import { actorIdentityAt, type BindingRow } from "../../src/api/actor-identity";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const row = (agentId: bigint, blockNumber: bigint, value: string | null, logIndex = 0): BindingRow => ({ agentId, blockNumber, logIndex, value });

describe("actorIdentityAt", () => {
  it("owner binding while no agentWallet is set; agentWallet once one is", () => {
    const owners = [row(7n, 100n, A)];
    const wallets = [row(7n, 200n, A)];
    expect(actorIdentityAt(A, 150n, wallets, owners)).toEqual({ agentId: "7", binding: "owner", atBlock: "150" });
    expect(actorIdentityAt(A, 200n, wallets, owners)).toEqual({ agentId: "7", binding: "agentWallet", atBlock: "200" });
  });

  it("an owner is not bound while another address is the agentWallet (R-S191-16)", () => {
    expect(actorIdentityAt(A, 300n, [row(7n, 200n, B)], [row(7n, 100n, A)])).toBeNull();
  });

  it("a cleared agentWallet falls back to the owner", () => {
    const wallets = [row(7n, 200n, B), row(7n, 250n, null)];
    expect(actorIdentityAt(A, 260n, wallets, [row(7n, 100n, A)])).toEqual({ agentId: "7", binding: "owner", atBlock: "260" });
  });

  it("resolves at the fact's own block, never later: a binding after the payment does not count", () => {
    expect(actorIdentityAt(A, 99n, [], [row(7n, 100n, A)])).toBeNull();
    expect(actorIdentityAt(A, 100n, [], [row(7n, 100n, A)])).not.toBeNull();
  });

  it("orders same-block rows by log index; a transfer away ends the owner binding", () => {
    const owners = [row(7n, 100n, B, 5), row(7n, 100n, A, 2)];
    expect(actorIdentityAt(A, 100n, [], owners)).toBeNull();
    expect(actorIdentityAt(B, 100n, [], owners)?.binding).toBe("owner");
  });

  it("absent for agentId 0, and on burn", () => {
    expect(actorIdentityAt(A, 500n, [row(0n, 100n, A)], [row(0n, 90n, A)])).toBeNull();
    expect(actorIdentityAt(A, 500n, [], [row(7n, 100n, A), row(7n, 400n, null)])).toBeNull();
  });

  it("several agentIds: agentWallet wins over owner, then the lowest agentId; case-insensitive", () => {
    const wallets = [row(9n, 100n, A.toUpperCase().replace("0X", "0x"))];
    const owners = [row(3n, 100n, A), row(5n, 100n, A)];
    expect(actorIdentityAt(A, 100n, wallets, owners)).toEqual({ agentId: "9", binding: "agentWallet", atBlock: "100" });
    expect(actorIdentityAt(A, 100n, [], owners)).toEqual({ agentId: "3", binding: "owner", atBlock: "100" });
  });
});
