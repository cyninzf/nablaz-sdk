// B4 part 1 against the live chains, both of them (R-S189-1): the external sources indexed over a fixed
// window per chain; one rendered s3 §6.4b line per source run through cast and compared with the reader's
// rows for that subject (R-D2B-1); GET /read served from the same index; the (c) share of the sampled
// redemptions reported, never asserted (R-S189-8 (iv)). Read-only: no anvil, no transaction.

import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { CURRENT_ACCOUNT_IMPL_LINEAGE, PROTOCOL_CONFIG } from "../../src/chains";
import { render } from "../../src/oneliners";
import { UPSTREAM, UPSTREAM_BASE, indexOnce, redact, stopAndDump, type Served, type Tables } from "./harness";

if (!UPSTREAM) throw new Error("READER_ARB_RPC_URL is not set: the fork tests run on both chains and do not skip");
if (!UPSTREAM_BASE) throw new Error("READER_BASE_RPC_URL is not set: the fork tests run on both chains and do not skip");

// Fixed windows, so the counts are reproducible. Each holds redemptions and at least one SpendPermissionUsed.
const WINDOWS = {
  42161: { from: 517_694_000, to: 517_695_500, spmAccount: "0x80d69a5A96274881B13aD93caa0C48081498948A" as Address },
  8453: { from: 53_160_000, to: 53_160_200, spmAccount: null as Address | null },
} as const;

type Run = { served: Served; tables: Tables };
const runs: Partial<Record<42161 | 8453, Run>> = {};

/** cast with the §6.4b RPC variables set from the reader's; output and errors are redacted. */
function cast(line: string, to: number): string {
  const bounded = line.replace(/--from-block (\d+)/, `--from-block $1 --to-block ${to}`);
  try {
    return execFileSync("bash", ["-o", "pipefail", "-c", bounded], {
      encoding: "utf8",
      env: { ...process.env, ARB_ONE_RPC_URL: UPSTREAM, BASE_RPC_URL: UPSTREAM_BASE },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(redact(String((e as { stderr?: string }).stderr ?? e)));
  }
}
const castLogCount = (line: string, to: number) => (JSON.parse(cast(`${line} --json`, to)) as unknown[]).length;

const lc = (s: unknown) => String(s).toLowerCase();

beforeAll(async () => {
  for (const chainId of [42161, 8453] as const) {
    const w = WINDOWS[chainId];
    const served = await indexOnce({
      rpcUrl: UPSTREAM,
      baseRpcUrl: UPSTREAM_BASE,
      chains: String(chainId),
      sources: "external",
      startBlock: w.from,
      endBlock: w.to,
      serve: true,
    });
    const { tables } = await stopAndDump(await reserve(served));
    runs[chainId] = { served, tables };
  }
});

// /read answers are collected while the server is up, then the server is stopped and the tables dumped.
const reads: Record<string, any> = {};
async function reserve(s: Served): Promise<Served> {
  const status = (await (await fetch(`${s.url}/status`)).json()) as Record<string, { id: number }>;
  const chainId = Object.values(status)[0]!.id;
  const subjects = chainId === 8453 ? ["0x92397432579b91B6De49f0f14AfF64628912667D"] : [WINDOWS[42161].spmAccount];
  for (const a of subjects) reads[`${chainId}-${a}`] = await (await fetch(`${s.url}/read/${chainId}/${a}`)).json();
  return s;
}

afterAll(async () => {
  for (const r of Object.values(runs)) await r?.served.stop();
});

describe.each([42161, 8453] as const)("chain %i, external sources", (chainId) => {
  const t = () => runs[chainId]!.tables;
  const w = WINDOWS[chainId];

  it("every row cites block, tx, log index, a §6.4b one-liner and the exact eth_getLogs", () => {
    for (const name of ["external_permissions", "external_payments", "external_redemptions"] as const) {
      expect(t()[name].length, name).toBeGreaterThan(0);
      for (const row of t()[name]) {
        expect(Number(row.block_number)).toBeGreaterThanOrEqual(w.from);
        expect(Number(row.block_number)).toBeLessThanOrEqual(w.to);
        expect(row.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(row.reproduce).toMatch(chainId === 8453 ? /"\$BASE_RPC_URL"/ : /"\$ARB_ONE_RPC_URL"/);
        expect(JSON.parse(row.reproduce_get_logs as string).method).toBe("eth_getLogs");
      }
    }
    expect(t().credit_line_events).toEqual([]); // no lender registered (R-S189-6)
  });

  it("(5) redemptions by root delegator: the rendered line through cast equals the reader's rows", () => {
    const root = t().external_redemptions[0]!.root_delegator as Address;
    const line = render("5-redeemed-delegation", { chainId, rootDelegator: root, from: w.from });
    const ours = t().external_redemptions.filter((r) => r.root_delegator === lc(root)).length;
    expect(castLogCount(line, w.to)).toBe(ours);
  });

  it("(5) payments: the receipt line finds exactly the reader's Transfers from the delegator, per tx", () => {
    const withPay = t().external_redemptions.filter((r) => r.had_transfer && r.hop === "root").slice(0, 3);
    expect(withPay.length).toBeGreaterThan(0);
    for (const r of withPay) {
      const line = render("5-delegator-transfer", { chainId, tx: r.tx_hash as `0x${string}`, rootDelegator: r.root_delegator as string });
      const castRows = cast(line, w.to).trim().split("\n").filter(Boolean);
      // R-S189-5: ERC-20 only; the jq line also matches an ERC-721 Transfer, which carries a 4th topic and no data.
      const erc20 = castRows.filter((x) => x.split("\t")[2] !== "0x");
      const ours = t().external_payments.filter((p) => p.redemption_tx === r.tx_hash && p.payer === r.root_delegator);
      expect(ours.length, r.tx_hash as string).toBe(erc20.length);
    }
    // A redemption with no Transfer writes no payment row.
    for (const r of t().external_redemptions.filter((x) => !x.had_transfer)) {
      expect(t().external_payments.filter((p) => p.redemption_tx === r.tx_hash && p.payer === r.delegator)).toEqual([]);
    }
  });

  it("(4) SpendPermissionUsed by account: the rendered line through cast equals the reader's payment rows", () => {
    const account = (w.spmAccount ?? t().external_payments.find((p) => p.source === "spm")?.payer) as Address | undefined;
    expect(account, "an SPM spend in the window").toBeDefined();
    const line = render("4-spm-used", { chainId, account: account!, from: w.from });
    const ours = t().external_payments.filter((p) => p.source === "spm" && p.payer === lc(account)).length;
    expect(ours).toBeGreaterThan(0);
    expect(castLogCount(line, w.to)).toBe(ours);
  });

  it("R-S189-8 (iv): reports the (c) share of the sampled redemptions", () => {
    const all = t().external_redemptions;
    const c = all.filter((r) => r.shape === "c").length;
    console.log(`(c) share, chain ${chainId}, blocks ${w.from}..${w.to}: ${c}/${all.length} redemptions labelled (c)`);
    expect(all.length).toBeGreaterThan(0);
  });
});

describe("GET /read", () => {
  it("Base delegator: facts carry source, label, citation and one-liner; notes state the empty sources", () => {
    const r = reads["8453-0x92397432579b91B6De49f0f14AfF64628912667D"];
    expect(r.chainId).toBe(8453);
    expect(r.selfDealing).toBeNull();
    expect(r.exposure).toBeNull();
    expect(r.notes).toContain("no NablaZ source on chain 8453 (R-S189-1)");
    expect(r.notes).toContain("no Agent Credit Lines lender registered on this chain");
    const sources = new Set(r.facts.map((f: any) => f.source));
    expect(sources).toEqual(new Set(["metamask:delegation", "metamask:redemption", "metamask:delegation_payment"]));
    for (const f of r.facts) {
      expect(f.label).toMatch(/^\((a|b|c|d|e)\) /);
      expect(f.cite).toMatchObject({ chainId: 8453 });
      expect(f.reproduce).toMatch(/^cast /);
      expect(JSON.stringify(f).toLowerCase()).not.toMatch(/"label":"[^"]*\bagent/);
    }
    const reds = runs[8453]!.tables.external_redemptions.filter((x) => x.root_delegator === lc("0x92397432579b91B6De49f0f14AfF64628912667D"));
    expect(r.facts.filter((f: any) => f.source === "metamask:redemption")).toHaveLength(reds.length);
  });

  it("Arbitrum SPM account: the spend is a payment fact labelled (a) per period", () => {
    const r = reads[`42161-${WINDOWS[42161].spmAccount}`];
    const pay = r.facts.filter((f: any) => f.source === "coinbase:spend_permission_payment");
    expect(pay.length).toBeGreaterThan(0);
    for (const f of pay) expect(f.label).toBe("(a) allowance, per period");
  });
});

describe("NablaZ canonical lineage", () => {
  it("the lineage tip is ProtocolConfig.currentAccountImpl()", async () => {
    const c = createPublicClient({ transport: http(UPSTREAM) });
    const current = await c.readContract({
      address: PROTOCOL_CONFIG,
      abi: parseAbi(["function currentAccountImpl() view returns (address)"]),
      functionName: "currentAccountImpl",
    });
    expect(current).toBe(CURRENT_ACCOUNT_IMPL_LINEAGE.at(-1));
  });
});
