// R-S219-6, R-S226-4: GET /read/:chainId/tx/:txHash, the any-hash door (src/api/tx.ts), against injected rows and
// chain lookups. The queries themselves need the tx_hash indexes of the next schema event; the door is off until then.

import { describe, expect, it } from "vitest";
import { NOT_READY, TX_ENV, TX_HASH, TX_SCOPE_NOTE, TX_SEARCHED, readTx, txEnabled, type TxDeps, type TxRows } from "../../src/api/tx";
import { creditLineFacts, paymentFacts, permissionFacts, recordFacts, redemptionFacts, vaultPaymentFacts } from "../../src/read";
import { withUtc } from "../../src/api/utc";
import type { NablaLabel } from "../../src/labels";
import { bannedHits } from "../../lib/wording";

const H = `0x${"ab".repeat(32)}`;
const HU = `0x${"AB".repeat(32)}`; // the same hash, upper case
const A = "0x00000000000000000000000000000000000000aa";
const W = "0x00000000000000000000000000000000000000bb";
const ev = (chainId: number, logIndex: number) => ({ chainId, blockNumber: 100n, blockTimestamp: 1_700_000_000n, txHash: H, logIndex, reproduce: "cast", reproduceGetLogs: "{}" });
const record = (l: number, writer: string) => ({ id: `r-${l}`, ...ev(42161, l), kindName: "PAY", subject: A, writer, kind: "0x01", writerAuth: "0x", counterparty: "0x", counterpartyAuth: "0x", policyHash: "0x", policyVersion: 1n, asset: "0x", amount: 7n, obligationRef: "0x", seq: 1n });
const vpay = (l: number) => ({ id: `v-${l}`, ...ev(42161, l), account: A, vault: "0x01", payee: "0x02", value: 9n, token: "0x03", nonce: "0x", submitter: "0x04", transferLogIndex: l + 1, fundingEntryId: null, settlements: 1, settlementOrdinalInTx: 0, settlementsInTx: 1, calls: null, callsStatus: "x", envelopeExpiry: 1_800_000_000n });
const perm = (l: number) => ({ id: "42161-spm-0xp1", ...ev(42161, l), source: "spm", subject: A, grantee: "0x05", permissionId: "0xp1", shape: "a", label: "(a) allowance, per period", terms: { start: 1_700_000_000, end: 1_800_000_000 }, status: "approved", useCount: 3 });
const xpay = (l: number, pid: string | null) => ({ id: `x-${l}`, ...ev(42161, l), source: "spm", payer: A, payee: "0x06", token: "0x07", amount: 11n, permissionId: pid, redemptionTx: null, redemptionLogIndex: null });
const red = (l: number) => ({ id: `d-${l}`, ...ev(42161, l), label: "(b) x", shape: "b", rootDelegator: A, redeemer: "0x08", delegate: "0x08", delegator: A, authority: "0x", hop: 0, delegationHash: "0x09", hadTransfer: false, enforcers: [] });
const credit = (l: number) => ({ id: `c-${l}`, ...ev(42161, l), label: "(e) lender", lender: "0x0a", agentId: 1n, loanId: 2n, kind: "Borrowed", party: A, principal: 5n, fee: 1n, dueAt: 1_800_000_000n });

const NONE: TxRows = { records: [], vaultPayments: [], permissions: [], payments: [], redemptions: [], creditLines: [], paymentPermissions: new Map() };
const LABEL: NablaLabel = { shape: "a", label: "(a) NablaZ account, canonical", canonicalImpl: true };

/** Deps that record every call; `block` is the chain lookup's answer (an Error is thrown). */
function fake(o: { rows?: TxRows; asOf?: bigint | null; block?: bigint | "pending" | null | Error; label?: NablaLabel | null } = {}) {
  const calls: string[] = [];
  const deps: TxDeps = {
    asOfBlock: async () => (calls.push("asOf"), o.asOf === undefined ? 1_000n : o.asOf),
    rows: async (h) => (calls.push(`rows ${h}`), o.rows ?? NONE),
    labelOf: async (a, b) => (calls.push(`label ${a} ${b}`), o.label ?? null),
    txBlock: async (h) => {
      calls.push(`txBlock ${h}`);
      if (o.block instanceof Error) throw o.block;
      return o.block === undefined ? null : o.block;
    },
  };
  return { calls, deps };
}
const run = (f: ReturnType<typeof fake>, chainId = "42161", txHash = H, enabled = true) =>
  readTx({ chainId, txHash }, { enabled, chainIds: [42161, 8453, 137], deps: () => f.deps });
const ser = (x: unknown) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

describe("flag", () => {
  it("off unless NABLAZ_TX is exactly \"on\"", () => {
    expect(TX_ENV).toBe("NABLAZ_TX");
    expect(txEnabled({})).toBe(false);
    for (const v of ["", "off", "true", "1", "ON", " on"]) expect(txEnabled({ NABLAZ_TX: v }), v).toBe(false);
    expect(txEnabled({ NABLAZ_TX: "on" })).toBe(true);
  });

  it("off: 503 {\"ready\":false} for any chain or hash, before any query or chain lookup", async () => {
    for (const [chain, hash] of [["42161", H], ["1", H], ["42161", "nope"]] as const) {
      const f = fake({ rows: { ...NONE, records: [record(0, A)] } });
      expect(await run(f, chain, hash, false)).toEqual({ status: 503, body: NOT_READY });
      expect(f.calls).toEqual([]);
    }
    expect(JSON.stringify(NOT_READY)).toBe(`{"ready":false}`);
  });

  it("the route hands the door the env flag and the enabled chains (src/api/index.ts)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/api/index.ts", import.meta.url), "utf8");
    const route = src.slice(src.indexOf('app.get("/read/:chainId/tx/:txHash"'));
    expect(route.slice(0, route.indexOf("\n});"))).toContain("{ enabled: txEnabled(), chainIds: enabledChains().map((x) => x.chainId), deps }");
    // Registered before the subject route.
    expect(src.indexOf('app.get("/read/:chainId/tx/:txHash"')).toBeLessThan(src.indexOf('app.get("/read/:chainId/:address"'));
  });
});

describe("hit", () => {
  it("every searched table's rows become the subject page's facts, citations and one-liners unchanged, in log order", async () => {
    const p = perm(1);
    const rows: TxRows = {
      records: [record(5, W)], // another writer's entry: an attestation, no label read
      vaultPayments: [vpay(3)],
      permissions: [p],
      payments: [xpay(2, "0xp1")],
      redemptions: [red(4)],
      creditLines: [credit(0)],
      paymentPermissions: new Map([[p.id, p]]),
    };
    const f = fake({ rows, label: LABEL });
    const a = await run(f, "42161", HU);
    expect(a.status).toBe(200);
    const body = a.body as { txHash: string; chainId: number; asOfBlock: string; facts: { cite: { logIndex: number } }[]; notes: string[] };
    expect([body.txHash, body.chainId, body.asOfBlock]).toEqual([H, 42161, "1000"]);
    const expected = withUtc([
      ...creditLineFacts(rows.creditLines),
      ...permissionFacts(rows.permissions),
      ...paymentFacts(rows.payments, rows.paymentPermissions),
      ...vaultPaymentFacts(rows.vaultPayments, LABEL),
      ...redemptionFacts(rows.redemptions),
      ...recordFacts(rows.records, null),
    ]);
    expect(ser(body.facts)).toEqual(ser(expected));
    expect(body.facts.map((x) => x.cite.logIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const x of body.facts as unknown as { cite: { tx: string; block: string; chainId: number } }[]) expect(x.cite).toMatchObject({ tx: H, block: "100", chainId: 42161 });
    // UTC siblings as on the subject page (R-S205-5).
    expect(JSON.stringify(ser(body.facts))).toContain("dueAtUtc");
    expect(body.notes[0]).toBe(TX_SCOPE_NOTE);
    // The hash is looked up lower-case; the label read only for the account whose own row it is; no chain lookup on a hit.
    expect(f.calls).toEqual(["asOf", `rows ${H}`, `label ${A} 1000`]);
  });

  it("an account's own record entry carries its NablaZ label, as on the subject page; a (c) label is noted", async () => {
    const c: NablaLabel = { shape: "c", label: "(c) not determinable", canonicalImpl: false, reason: "no Upgraded event seen for the account" };
    const rows = { ...NONE, records: [record(0, A)] };
    const a = await run(fake({ rows, label: c }));
    const body = a.body as { facts: unknown[]; notes: string[] };
    expect(ser(body.facts)).toEqual(ser(withUtc(recordFacts(rows.records, c))));
    expect(body.notes).toContain(`NablaZ label for 0x00000000000000000000000000000000000000AA: (c) not determinable (no Upgraded event seen for the account)`);
  });
});

describe("a hash the record does not hold: 404, the body says why (S222)", () => {
  const body404 = async (o: Parameters<typeof fake>[0]) => {
    const f = fake(o);
    const a = await run(f);
    expect(a.status).toBe(404);
    return { body: a.body as Record<string, unknown>, calls: f.calls };
  };

  it("unknown-hash: the chain has no such transaction", async () => {
    const { body, calls } = await body404({ block: null });
    expect(body).toEqual({ error: `chain 42161 has no transaction ${H}`, reason: "unknown-hash", txBlock: null, txHash: H, chainId: 42161, asOfBlock: "1000", notes: [TX_SCOPE_NOTE] });
    expect(calls).toEqual(["asOf", `rows ${H}`, `txBlock ${H}`]);
  });

  it("not-indexed: above the indexed block, or pending", async () => {
    expect((await body404({ block: 1_001n })).body).toMatchObject({ error: `tx ${H} is at block 1001; chain 42161 is indexed up to 1000`, reason: "not-indexed", txBlock: "1001" });
    expect((await body404({ block: "pending" })).body).toMatchObject({ error: `tx ${H} is pending, in no block yet`, reason: "not-indexed", txBlock: null });
  });

  it("no-fact: at or below the indexed block, anchoring no fact the record holds", async () => {
    expect((await body404({ block: 1_000n })).body).toMatchObject({ error: `the record holds no fact anchored by tx ${H} (block 1000, indexed up to 1000)`, reason: "no-fact", txBlock: "1000" });
  });

  it("not-determinable: the chain lookup failed; no RPC text reaches the body", async () => {
    const { body } = await body404({ block: new Error("HTTP request failed. URL: https://rpc.example/key-123") });
    expect(body.reason).toBe("not-determinable");
    expect(JSON.stringify(body)).not.toMatch(/rpc\.example|key-123|HTTP request/);
  });

  it("the four reasons are distinct, and no body uses a banned word", async () => {
    const bodies = await Promise.all([null, 1_001n, 1_000n, new Error("x")].map(async (block) => (await body404({ block })).body));
    expect(new Set(bodies.map((b) => b.reason))).toEqual(new Set(["unknown-hash", "not-indexed", "no-fact", "not-determinable"]));
    expect(bannedHits(JSON.stringify(bodies) + TX_SCOPE_NOTE)).toEqual([]);
  });
});

describe("other answers", () => {
  it("an unread chain: GET /read's own {\"error\":\"chain N is not read here\"}, byte for byte, nothing queried", async () => {
    const f = fake();
    const a = await run(f, "1");
    expect([a.status, JSON.stringify(a.body)]).toEqual([404, `{"error":"chain 1 is not read here"}`]);
    expect(JSON.stringify((await run(fake(), "abc")).body)).toBe(`{"error":"chain abc is not read here"}`);
    expect(f.calls).toEqual([]);
  });

  it("not a hash: 400, nothing queried", async () => {
    for (const h of ["0x12", `${H}00`, H.slice(2), `0x${"zz".repeat(32)}`, ""]) {
      const f = fake();
      expect(await run(f, "42161", h), h).toEqual({ status: 400, body: { error: "not a transaction hash" } });
      expect(f.calls).toEqual([]);
    }
    expect(TX_HASH.test(H) && TX_HASH.test(HU)).toBe(true);
  });

  it("no checkpoint yet: 503, as GET /read", async () => {
    const f = fake({ asOf: null });
    expect(await run(f)).toEqual({ status: 503, body: { error: "indexer has no checkpoint for this chain yet" } });
    expect(f.calls).toEqual(["asOf"]);
  });

  it("the searched tables are the six the subject page renders from rows alone (the next schema event's tx_hash indexes)", () => {
    expect([...TX_SEARCHED]).toEqual(["record_entries", "vault_payments", "external_permissions", "external_payments", "external_redemptions", "credit_line_events"]);
  });
});
