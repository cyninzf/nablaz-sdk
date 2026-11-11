// The read API. Keyless: no key, no account, no write. GET /read/:chainId/:address returns every indexed fact
// about the address with its source, permission label, citation and reproducing one-liner. Assembly is in
// src/read.ts; this file runs the queries and the state reads (at the indexed block, never the chain head).
// State reads go through the indexer's transport; the grounding reads through the grounding client only
// (src/rpc.ts, R-S192-8).

import { Hono } from "hono";
import { db, publicClients } from "ponder:api";
import {
  accounts,
  agentOwners,
  agentWallets,
  creditLineEvents,
  externalPayments,
  externalPermissions,
  externalRedemptions,
  factoryAccounts,
  feedbacks,
  grants,
  implementationHistory,
  recordEntries,
  vaultPayments,
  vaults,
} from "ponder:schema";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "ponder";
import { erc20Abi, getAddress, isAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { ConsumerAIMandateV4Abi, NablaAccountV3_1Abi } from "@nablaz/sdk/abis";
import { enabledChains, externalStart, hasNabla, nablaStart, sourcesOn, type EnabledChain } from "../chains";
import { canonicalLineage, nablaLabel, type NablaLabel } from "../labels";
import { withUtc } from "./utc";
import { PROBE_MS, dbWatchdog, heartbeatSql } from "./db-watchdog";
import { boundedLag, chainLag, endBlockOf, headCache, type IndexedBlock } from "./head";
import { FEED_RECORD_KINDS, externalPaymentItems, page, parseFeedQuery, permissionIdOf, permissionItems, recordItems, vaultPaymentItems, type FeedKey } from "./feed";
import { bindingsAtTransferBlocks, boundHistory, transfersFrom, walletAt } from "../grounding-rpc";
import { groundingClient, rpcMetricsText } from "../rpc";
import {
  FEEDBACK_URI_NOT_READ,
  GROUNDING_SOURCE,
  NATIVE_NOT_READ,
  cShare,
  controllerAt,
  creditLineFacts,
  groundingFact,
  groundingTransfers,
  emptySourceNotes,
  exposure,
  notDeterminableNotes,
  paymentFacts,
  permissionFacts,
  recordFacts,
  redemptionFacts,
  selfDealing,
  vaultPaymentFacts,
  type ControllerInput,
  type ExposureGrant,
  type Fact,
  type LabelledPayment,
  type RaterTransfer,
  type Payment,
} from "../read";

const app = new Hono();

// Exit, not idle, on database loss (src/api/db-watchdog.ts). Postgres only: PGlite (no DATABASE_URL) is in-process.
if (process.env.DATABASE_URL) {
  const schema = (globalThis as { PONDER_NAMESPACE_BUILD?: { schema: string } }).PONDER_NAMESPACE_BUILD!.schema;
  const check = dbWatchdog(() => db.execute(sql.raw(heartbeatSql(schema))).then((r) => Number((r.rows[0] as { h?: unknown } | undefined)?.h)));
  setInterval(check, PROBE_MS).unref();
}

const groundingClients = new Map<number, PublicClient>();
const groundingOf = (chain: EnabledChain) => {
  if (!groundingClients.has(chain.chainId)) groundingClients.set(chain.chainId, groundingClient(chain));
  return groundingClients.get(chain.chainId)!;
};

const lc = (a: string) => a.toLowerCase() as Hex;
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function indexedBlock(origin: string, chain: EnabledChain): Promise<bigint | null> {
  const r = await fetch(new URL("/status", origin));
  if (!r.ok) return null;
  const s = (await r.json()) as Record<string, { block: { number: number } }>;
  const n = s[chain.name]?.block.number;
  return n === undefined ? null : BigInt(n);
}

/** Ponder's /status: each chain's indexed block (number and timestamp), by chain name. */
async function indexedStatus(origin: string): Promise<Record<string, IndexedBlock> | null> {
  const r = await fetch(new URL("/status", origin));
  if (!r.ok) return null;
  const s = (await r.json()) as Record<string, { block: IndexedBlock }>;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.block]));
}

// B1: the chain heads behind GET /ready/head, cached per chain (src/api/head.ts). Read on the indexer's transport.
const heads = headCache(
  async (name) => {
    const b = await (publicClients as Record<string, PublicClient>)[name]!.getBlock({ blockTag: "latest" });
    return { number: b.number, timestamp: b.timestamp };
  },
  Date.now,
  { onError: (name, e) => console.error(`head read failed for ${name}: ${String((e as Error).message ?? e).split("\n")[0]}`) },
);

async function codeHash(client: PublicClient, address: Address, blockNumber: bigint): Promise<Hex | null> {
  const code = await client.getCode({ address, blockNumber });
  return code && code !== "0x" ? keccak256(code) : null;
}

async function controllerInput(chainId: number, account: Hex, canonicalImpl: boolean): Promise<ControllerInput> {
  const rotations = await db
    .select()
    .from(recordEntries)
    .where(and(eq(recordEntries.chainId, chainId), eq(recordEntries.subject, account), eq(recordEntries.kindName, "CONTROLLER_ROTATED")));
  const [f] = await db.select().from(factoryAccounts).where(eq(factoryAccounts.id, `${chainId}-${account}`));
  return { rotations, factoryOwner: (f?.owner as Address) ?? null, canonicalImpl };
}

async function implementationsOf(chainId: number, account: Hex): Promise<Address[]> {
  const ups = await db
    .select()
    .from(implementationHistory)
    .where(and(eq(implementationHistory.chainId, chainId), eq(implementationHistory.account, account), eq(implementationHistory.source, "Upgraded")))
    .orderBy(asc(implementationHistory.blockNumber), asc(implementationHistory.logIndex));
  return ups.map((u) => u.implementation as Address);
}

/** The NablaZ label of an account at the read block (lineage from Upgraded events, mandate code hash). */
async function nablaLabelOf(client: PublicClient, chain: EnabledChain & { nabla: { ConsumerAIMandateV4: Address } }, account: Hex, asOfBlock: bigint): Promise<NablaLabel> {
  const implementations = await implementationsOf(chain.chainId, account);
  const deps = await client
    .readContract({ address: account, abi: NablaAccountV3_1Abi, functionName: "dependencies", blockNumber: asOfBlock })
    .catch(() => null);
  const mandate = deps ? (deps[0] as Address) : null;
  const camV4CodeHash = (await codeHash(client, chain.nabla.ConsumerAIMandateV4, asOfBlock))!;
  const mandateCodeHash = mandate ? await codeHash(client, mandate, asOfBlock) : null;
  return nablaLabel({ implementations, mandateCodeHash, camV4CodeHash });
}

// Row E: the RPC legs' counters (src/rpc.ts), Prometheus text, beside Ponder's own /metrics. The reader listens on
// 127.0.0.1 only and the front relays /read, /feed and /ready (as /ready/head) alone, so this is never public.
app.get("/metrics/reader", (c) => c.text(rpcMetricsText(), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }));

// B1 (S213): readiness with the head gate. 200 (empty body, as Ponder's /ready) only when Ponder's /ready is 200 and
// every enabled chain's indexed block is current with its head (src/api/head.ts); 503 otherwise. Loopback only: the
// front relays it as the public /ready and maps the 503 to {"ready":false}.
app.get("/ready/head", async (c) => {
  const ponderReady = await fetch(new URL("/ready", c.req.url));
  if (ponderReady.status !== 200) return c.text("Historical indexing is not complete.", 503);
  const status = await indexedStatus(c.req.url);
  if (!status) return c.text("Indexed head not readable.", 503);
  const end = endBlockOf();
  const lags = await Promise.all(
    enabledChains().map(async (ch) => (end !== undefined ? boundedLag(ch.name, status[ch.name], end) : chainLag(ch.name, status[ch.name], await heads.head(ch.name)))),
  );
  const behind = lags.filter((l) => !l.current);
  if (behind.length) return c.text(`Indexed head is not current: ${behind.map((l) => `${l.chain}: ${"reason" in l ? l.reason : ""}`).join("; ")}`, 503);
  return c.text("", 200);
});

// B2 (S213, R-S213-1): GET /feed, the Live Sky door (src/api/feed.ts). Existing tables only; no amounts, no counts.
app.get("/feed", async (c) => {
  const q = parseFeedQuery(c.req.query("limit"), c.req.query("before"));
  if ("error" in q) return c.json({ error: q.error }, 400);
  const status = await indexedStatus(c.req.url);
  const chains = enabledChains();
  if (!status || chains.some((ch) => status[ch.name] === undefined)) return c.json({ ready: false }, 503);
  const asOf = new Map(chains.map((ch) => [ch.chainId, BigInt(status[ch.name]!.number)]));
  // Per table: rows at or below each chain's asOfBlock and at or before the cursor key (the page drops the cursor's
  // own item), newest first; a few more than the limit, for rows that share the cursor's key.
  const n = q.limit + 3;
  type T = { chainId: any; blockNumber: any; blockTimestamp: any; logIndex: any };
  const window = (t: T) => {
    const asOfCond = or(...chains.map((ch) => and(eq(t.chainId, ch.chainId), sql`${t.blockNumber} <= ${asOf.get(ch.chainId)!.toString()}::numeric(78)`)));
    const k: FeedKey | null = q.before;
    return k
      ? and(asOfCond, sql`(${t.blockTimestamp}, ${t.chainId}, ${t.blockNumber}, ${t.logIndex}) <= (${k[0].toString()}::numeric(78), ${k[1]}::integer, ${k[2].toString()}::numeric(78), ${k[3]}::integer)`)
      : asOfCond;
  };
  const order = (t: T) => [desc(t.blockTimestamp), desc(t.chainId), desc(t.blockNumber), desc(t.logIndex)];
  const [records, perms, vpays, xpays] = await Promise.all([
    db.select().from(recordEntries).where(and(window(recordEntries), inArray(recordEntries.kindName, Object.keys(FEED_RECORD_KINDS)))).orderBy(...order(recordEntries)).limit(n),
    db.select().from(externalPermissions).where(window(externalPermissions)).orderBy(...order(externalPermissions)).limit(n),
    db.select().from(vaultPayments).where(window(vaultPayments)).orderBy(...order(vaultPayments)).limit(n),
    db.select().from(externalPayments).where(window(externalPayments)).orderBy(...order(externalPayments)).limit(n),
  ]);
  const entryIds = [...new Set(vpays.map((p) => p.fundingEntryId).filter((x): x is string => !!x))];
  const entries = entryIds.length ? await db.select().from(recordEntries).where(inArray(recordEntries.id, entryIds)) : [];
  const permIds = [...new Set(xpays.map(permissionIdOf).filter((x): x is string => !!x))];
  const payPerms = permIds.length ? await db.select().from(externalPermissions).where(inArray(externalPermissions.id, permIds)) : [];
  const { items, next } = page(
    [
      ...recordItems(records),
      ...permissionItems(perms),
      ...vaultPaymentItems(vpays, new Map(entries.map((e) => [e.id, e]))),
      ...externalPaymentItems(xpays, new Map(payPerms.map((p) => [p.id, p]))),
    ],
    q,
    asOf,
  );
  const asOfBlock = Object.fromEntries(chains.map((ch) => [String(ch.chainId), asOf.get(ch.chainId)!.toString()]));
  return c.body(json({ asOfBlock, items, nextBefore: next }), 200, { "content-type": "application/json" });
});

app.get("/read/:chainId/:address", async (c) => {
  const chainId = Number(c.req.param("chainId"));
  const raw = c.req.param("address");
  const chain = enabledChains().find((x) => x.chainId === chainId);
  if (!chain) return c.json({ error: `chain ${c.req.param("chainId")} is not read here` }, 404);
  if (!isAddress(raw, { strict: false })) return c.json({ error: "not an address" }, 400);
  const subject = getAddress(raw);
  const a = lc(subject);
  const asOfBlock = await indexedBlock(c.req.url, chain);
  if (asOfBlock === null) return c.json({ error: "indexer has no checkpoint for this chain yet" }, 503);
  const client = (publicClients as Record<string, PublicClient>)[chain.name]!;
  const notes: string[] = [];

  // Indexed rows.
  const records = await db.select().from(recordEntries).where(and(eq(recordEntries.chainId, chainId), eq(recordEntries.subject, a)));
  const vpay = await db.select().from(vaultPayments).where(and(eq(vaultPayments.chainId, chainId), eq(vaultPayments.account, a)));
  const perms = await db
    .select()
    .from(externalPermissions)
    .where(and(eq(externalPermissions.chainId, chainId), or(eq(externalPermissions.subject, a), eq(externalPermissions.grantee, a))));
  const pays = await db
    .select()
    .from(externalPayments)
    .where(and(eq(externalPayments.chainId, chainId), or(eq(externalPayments.payer, a), eq(externalPayments.payee, a))));
  const reds = await db
    .select()
    .from(externalRedemptions)
    .where(
      and(
        eq(externalRedemptions.chainId, chainId),
        or(eq(externalRedemptions.rootDelegator, a), eq(externalRedemptions.delegator, a), eq(externalRedemptions.delegate, a)),
      ),
    );
  const credit = await db.select().from(creditLineEvents).where(and(eq(creditLineEvents.chainId, chainId), eq(creditLineEvents.party, a)));
  const payPermIds = [...new Set(pays.map((p) => `${chainId}-${p.source === "spm" ? "spm" : "dm"}-${lc(p.permissionId ?? "0x")}`))];
  const payPerms = payPermIds.length ? await db.select().from(externalPermissions).where(inArray(externalPermissions.id, payPermIds)) : [];
  const permById = new Map(payPerms.map((p) => [p.id, p]));

  // NablaZ account: label, self-dealing, exposure (Arbitrum only, R-S189-1).
  let nabla: NablaLabel | null = null;
  let selfDealingOut: unknown = null;
  let exposureOut: unknown = null;
  const [acct] = hasNabla(chain) ? await db.select().from(accounts).where(eq(accounts.id, `${chainId}-${a}`)) : [];
  if (hasNabla(chain) && acct) {
    const implementations = await implementationsOf(chainId, a);
    const deps = await client
      .readContract({ address: subject, abi: NablaAccountV3_1Abi, functionName: "dependencies", blockNumber: asOfBlock })
      .catch(() => null);
    const mandate = deps ? (deps[0] as Address) : null;
    const camV4CodeHash = (await codeHash(client, chain.nabla.ConsumerAIMandateV4, asOfBlock))!;
    const mandateCodeHash = mandate ? await codeHash(client, mandate, asOfBlock) : null;
    nabla = nablaLabel({ implementations, mandateCodeHash, camV4CodeHash });
    if (nabla.shape === "c") notes.push(`NablaZ label for ${subject}: ${nabla.label} (${nabla.reason})`);

    // Payments from the account: vault settlements (one per authorization, R-D2B-6) and its own PAY entries.
    const payments: Payment[] = [
      ...vpay
        .filter((p) => p.payee !== null && p.value !== null)
        .map((p) => ({ payee: p.payee as Address, token: p.token as Address, value: p.value as bigint, block: p.blockNumber, cite: { chainId, block: String(p.blockNumber), tx: p.txHash, logIndex: p.logIndex } })),
      ...records
        .filter((r) => r.kindName === "PAY" && lc(r.writer) === a)
        .map((r) => ({ payee: r.counterparty as Address, token: r.asset as Address, value: r.amount, block: r.blockNumber, cite: { chainId, block: String(r.blockNumber), tx: r.txHash, logIndex: r.logIndex } })),
    ];
    const payees = [...new Set(payments.map((p) => lc(p.payee)))];
    const payeeAccounts = payees.length
      ? await db.select().from(accounts).where(inArray(accounts.id, payees.map((p) => `${chainId}-${p}`)))
      : [];
    const payeeControllers = new Map<string, ControllerInput>();
    for (const pa of payeeAccounts) {
      const impls = await implementationsOf(chainId, lc(pa.account));
      const ok = canonicalLineage({ implementations: impls }).ok;
      payeeControllers.set(lc(pa.account), await controllerInput(chainId, lc(pa.account), ok));
    }
    const withRecord = payees.length
      ? await db
          .selectDistinct({ subject: recordEntries.subject })
          .from(recordEntries)
          .where(and(eq(recordEntries.chainId, chainId), inArray(recordEntries.subject, payees)))
      : [];
    const sd = selfDealing({
      subject,
      subjectController: await controllerInput(chainId, a, nabla.canonicalImpl),
      payments,
      payeeControllers,
      payeesWithRecord: new Set(withRecord.map((r) => lc(r.subject))),
    });
    selfDealingOut = sd.result;
    notes.push(...sd.notes);

    // Exposure: per grant and token, min remaining over windows + vault balance; only on canonical CAM V4.
    const canonicalMandate = mandateCodeHash !== null && mandateCodeHash === camV4CodeHash;
    const gs = await db.select().from(grants).where(and(eq(grants.chainId, chainId), eq(grants.subject, a)));
    const vs = await db.select().from(vaults).where(and(eq(vaults.chainId, chainId), eq(vaults.account, a)));
    const eg: ExposureGrant[] = [];
    if (canonicalMandate) {
      for (const g of gs) {
        const grant = await client.readContract({
          address: mandate!,
          abi: ConsumerAIMandateV4Abi,
          functionName: "grantOf",
          args: [subject, g.grantId],
          blockNumber: asOfBlock,
        });
        const vault = vs.find((v) => v.granteeKey !== null && lc(v.granteeKey) === lc(g.granteeKey));
        const tokens = [...new Set(grant.allowances.map((x) => lc(x.allowance.tokenAddress)))];
        for (const token of tokens) {
          const balance = vault
            ? await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault.vault], blockNumber: asOfBlock })
            : null;
          eg.push({
            grantId: g.grantId,
            token: getAddress(token),
            remaining: grant.allowances.filter((x) => lc(x.allowance.tokenAddress) === token).map((x) => BigInt(x.remaining)),
            vault: vault ? getAddress(vault.vault) : null,
            vaultBalance: balance,
          });
        }
      }
    }
    const ex = exposure(canonicalMandate, eg, asOfBlock);
    exposureOut = ex.result;
    notes.push(...ex.notes);
  } else if (hasNabla(chain)) {
    notes.push(`self-dealing and exposure: ${subject} is not a NablaZ account on chain ${chainId}`);
  }

  // ERC-8004 feedback grounding (R-D2B-2, R-S191-11, R-S191-16): when the subject has been the agentWallet or the
  // owner of an indexed agentId. A feedback is grounded by any ERC-20 Transfer from the rater to the address bound at the
  // transfer's block: getAgentWallet there, else ownerOf there. The rater's transfers are read by eth_getLogs (topic1 = rater, any token) from the
  // Identity Registry's start (no agentWallet exists before it) to the feedback block; a settlement from one of
  // the rater's own grantee vaults counts as from the rater. A transfer that is an indexed payment fact keeps its
  // label; any other is (c), "direct transfer, no permission object".
  const external = sourcesOn().has("external");
  const walletRows = external
    ? await db
        .selectDistinct({ agentId: agentWallets.agentId })
        .from(agentWallets)
        .where(and(eq(agentWallets.chainId, chainId), isNotNull(agentWallets.wallet), eq(agentWallets.wallet, a)))
    : [];
  const ownerRows = external
    ? await db
        .selectDistinct({ agentId: agentOwners.agentId })
        .from(agentOwners)
        .where(and(eq(agentOwners.chainId, chainId), isNotNull(agentOwners.owner), eq(agentOwners.owner, a)))
    : [];
  // R-S191-16: an agentId is the subject's when the subject has been its agentWallet or its owner.
  const agentIds = [...new Set([...walletRows, ...ownerRows].map((w) => w.agentId))];
  const fbs = agentIds.length
    ? await db.select().from(feedbacks).where(and(eq(feedbacks.chainId, chainId), inArray(feedbacks.agentId, agentIds)))
    : [];
  const groundingFacts: Fact[] = [];
  if (fbs.length) {
    const registry = chain.external.IdentityRegistry;
    const grounding = groundingOf(chain);
    const transfersFromBlock = externalStart(chain, "IdentityRegistry");
    const nablaOn = hasNabla(chain) && sourcesOn().has("nabla");
    const controllerOf = async (who: Hex, block: bigint) => {
      if (!hasNabla(chain)) return null;
      const [isAccount] = await db.select().from(accounts).where(eq(accounts.id, `${chainId}-${who}`));
      if (!isAccount) return null;
      const ok = canonicalLineage({ implementations: await implementationsOf(chainId, who) }).ok;
      return controllerAt(getAddress(who), block, await controllerInput(chainId, who, ok));
    };
    // Per rater: its transfers up to its latest feedback here, and its indexed payment facts (with labels).
    const raters = new Map<string, Promise<{ transfers: RaterTransfer[]; labelled: LabelledPayment[] } | { error: string }>>();
    const raterData = (rater: Hex, upTo: bigint) => {
      if (!raters.has(rater))
        raters.set(
          rater,
          (async () => {
            try {
              const transfers = await transfersFrom(grounding, chainId, getAddress(rater), BigInt(transfersFromBlock), upTo);
              const labelled: LabelledPayment[] = [];
              if (nablaOn) {
                const vout = await db.select().from(vaultPayments).where(and(eq(vaultPayments.chainId, chainId), eq(vaultPayments.account, rater)));
                const label = vout.length ? await nablaLabelOf(client, chain as never, rater, asOfBlock) : null;
                for (const v of vout) {
                  if (v.payee === null || v.value === null || v.transferLogIndex === null || v.blockNumber > upTo) continue;
                  const [fact] = vaultPaymentFacts([v], label);
                  labelled.push({ fact: fact!, tx: v.txHash, transferLogIndex: v.transferLogIndex });
                  // The vault's Transfer is sent by the vault; it is the rater's payment (the payer is the account).
                  transfers.push({ chainId, token: getAddress(v.token), from: getAddress(rater), to: getAddress(v.payee), amount: v.value, block: v.blockNumber, tx: v.txHash, logIndex: v.transferLogIndex });
                }
              }
              const out = await db.select().from(externalPayments).where(and(eq(externalPayments.chainId, chainId), eq(externalPayments.payer, rater)));
              const facts = paymentFacts(out, permById);
              out.forEach((p, i) => {
                // A delegation payment row is its Transfer log; an SPM payment row is SpendPermissionUsed, so its
                // Transfer is the one in the same tx to the same payee with the same amount.
                const t =
                  p.source === "spm"
                    ? transfers.find((x) => lc(x.tx) === lc(p.txHash) && lc(x.to) === lc(p.payee) && x.amount === p.amount)
                    : transfers.find((x) => lc(x.tx) === lc(p.txHash) && x.logIndex === p.logIndex);
                if (t) labelled.push({ fact: facts[i]!, tx: p.txHash, transferLogIndex: t.logIndex });
              });
              return { transfers, labelled };
            } catch (e) {
              return { error: String((e as Error).message ?? e).split("\n")[0]! };
            }
          })(),
        );
      return raters.get(rater)!;
    };
    const lastFeedback = new Map<string, bigint>();
    for (const f of fbs) {
      const r = lc(f.client);
      if ((lastFeedback.get(r) ?? 0n) < f.blockNumber) lastFeedback.set(r, f.blockNumber);
    }
    for (const f of fbs) {
      const rater = lc(f.client);
      const data = await raterData(rater, lastFeedback.get(rater)!);
      let payments: ReturnType<typeof groundingTransfers> | { error: string };
      if ("error" in data) payments = data;
      else {
        try {
          const prior = data.transfers.filter((t) => t.block <= f.blockNumber);
          const candidates = await boundHistory(grounding, registry, f.agentId, BigInt(transfersFromBlock), f.blockNumber);
          payments = groundingTransfers(prior, await bindingsAtTransferBlocks(grounding, registry, f.agentId, prior, candidates), data.labelled);
        } catch (e) {
          payments = { error: String((e as Error).message ?? e).split("\n")[0]! };
        }
      }
      const walletAtFeedback = await walletAt(grounding, registry, f.agentId, f.blockNumber).catch((e) => ({ error: String((e as Error).message ?? e).split("\n")[0]! }));
      groundingFacts.push(
        groundingFact({
          subject,
          feedback: f,
          payments,
          transfersRange: { from: transfersFromBlock, to: f.blockNumber },
          walletAtFeedback,
          raterController: await controllerOf(rater, f.blockNumber),
          subjectController: await controllerOf(a, f.blockNumber),
        }),
      );
    }
    notes.push(FEEDBACK_URI_NOT_READ, NATIVE_NOT_READ);
    for (const g of groundingFacts) {
      const t = g.terms as { grounding: string; reason?: string };
      if (t.grounding !== "grounded") notes.push(`${GROUNDING_SOURCE} at block ${g.cite.block} tx ${g.cite.tx} log ${g.cite.logIndex}: ${t.grounding}${t.reason ? ` (${t.reason})` : ""}`);
    }
  }

  const facts: Fact[] = [
    ...recordFacts(records, nabla),
    ...vaultPaymentFacts(vpay, nabla),
    ...permissionFacts(perms),
    ...paymentFacts(pays, permById),
    ...redemptionFacts(reds),
    ...creditLineFacts(credit),
    ...groundingFacts,
  ].sort((x, y) => (BigInt(x.cite.block) === BigInt(y.cite.block) ? x.cite.logIndex - y.cite.logIndex : BigInt(x.cite.block) < BigInt(y.cite.block) ? -1 : 1));

  const range = (from: number | null) => ({ from, to: asOfBlock });
  notes.push(
    ...emptySourceNotes({
      chainId,
      hasNabla: hasNabla(chain),
      indexed: sourcesOn(),
      lenders: chain.external.creditLineLenders.length,
      counts: {
        record: records.length,
        vault_payment: vpay.length,
        spm: perms.filter((p) => p.source === "spm").length + pays.filter((p) => p.source === "spm").length,
        dm: reds.length,
        credit: credit.length,
        agent_wallet: agentIds.length,
        feedback: fbs.length,
      },
      ranges: {
        record: range(nablaStart(chain)),
        vault_payment: range(nablaStart(chain)),
        spm: range(externalStart(chain, "SpendPermissionManager")),
        dm: range(externalStart(chain, "DelegationManager")),
        credit: range(externalStart(chain, "creditLineLenders")),
        agent_wallet: range(externalStart(chain, "IdentityRegistry")),
        feedback: range(externalStart(chain, "ReputationRegistry")),
      },
    }),
    ...notDeterminableNotes(facts),
  );

  // R-S190-3: per token, the payment facts in this read labelled (c), over all payment facts.
  const cShareOut = { chainId, asOfBlock: asOfBlock.toString(), byToken: cShare(facts) };
  return c.body(json({ subject, chainId, asOfBlock, facts: withUtc(facts), selfDealing: selfDealingOut, exposure: exposureOut, cShare: cShareOut, notes }), 200, {
    "content-type": "application/json",
  });
});

export default app;
