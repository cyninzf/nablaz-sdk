// R-S190-7: the guard, its red fixtures, and its application to the reader's notes and the README.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWED_NAMES, bannedHits } from "../../src/wording";
import { DIRECT_TRANSFER, FEEDBACK_URI_NOT_READ, NO_TRANSFER, emptySourceNotes, groundingFact, groundingTransfers, rangeNote } from "../../src/read";

describe("guard", () => {
  it("allows only the exact name Reputation Registry", () => {
    expect(ALLOWED_NAMES).toEqual(["Reputation Registry"]);
    expect(bannedHits('the ERC-8004 "Reputation Registry" emits NewFeedback')).toEqual([]);
  });
  it("red fixtures still fail", () => {
    expect(bannedHits("a trust score for the address")).toEqual(["trust", "score"]);
    expect(bannedHits("the reputation of the agent")).toEqual(["reputation"]);
    expect(bannedHits("reputation registry")).toEqual(["reputation"]);
    expect(bannedHits("the Reputation Registry's reputation")).toEqual(["reputation"]);
    expect(bannedHits("ReputationRegistry")).toEqual(["Reputation"]);
    expect(bannedHits("ranked by verdict, a credit bureau")).toEqual(["rank", "verdict", "credit bureau"]);
  });
});

describe("applied", () => {
  it("to every note and grounding reason the reader can write", () => {
    const r = { from: 1, to: 10n };
    const notes = [
      ...emptySourceNotes({ chainId: 8453, hasNabla: false, indexed: new Set(["external"]), lenders: 0, counts: { agent_wallet: 1 }, ranges: { spm: r, dm: r, agent_wallet: r, feedback: r } }),
      ...emptySourceNotes({ chainId: 8453, hasNabla: true, indexed: new Set(["nabla"]), lenders: 0, counts: {}, ranges: {} }),
      rangeNote("x", { from: 20, to: 10n }),
      FEEDBACK_URI_NOT_READ,
      NO_TRANSFER,
    ];
    const f = { chainId: 8453, blockNumber: 5n, txHash: "0x01", logIndex: 1, reproduce: "", agentId: 1n, client: "0x00000000000000000000000000000000000000c1", feedbackIndex: 1n };
    const W = "0x00000000000000000000000000000000000000b1" as const;
    const t = { chainId: 8453, token: W, from: f.client as `0x${string}`, to: W, amount: 1n, block: 4n, tx: "0x02" as const, logIndex: 0 };
    for (const payments of [groundingTransfers([t], () => W, []), [], { error: "e" }]) {
      for (const transfersRange of [{ from: 1, to: 5n }, { from: 9, to: 5n }]) {
        for (const walletAtFeedback of [W, null, { error: "e" }]) {
          notes.push(JSON.stringify(groundingFact({ subject: W, feedback: f, payments, transfersRange, walletAtFeedback, raterController: null, subjectController: null })));
        }
      }
    }
    notes.push(DIRECT_TRANSFER);
    for (const n of notes) expect(bannedHits(n), n).toEqual([]);
  });
  it("to the README", () => {
    const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
    expect(bannedHits(readme)).toEqual([]);
  });
});
