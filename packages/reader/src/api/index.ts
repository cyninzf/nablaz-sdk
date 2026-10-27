// The read API. Keyless: no key, no account, no write. GET /read/:chainId/:address returns every indexed fact
// about the address with its source, permission label, citation and reproducing one-liner. Assembly is in
// src/read.ts; this file runs the queries and the state reads (at the indexed block, never the chain head).

import { Hono } from "hono";
import { db, publicClients } from "ponder:api";
import {
  accounts,
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
import { and, asc, eq, inArray, isNotNull, or } from "ponder";
import { erc20Abi, getAddress, isAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { ConsumerAIMandateV4Abi, NablaAccountV3_1Abi } from "@nablaz/sdk/abis";
import { enabledChains, externalStart, hasNabla, nablaStart, sourcesOn, type EnabledChain } from "../chains";
import { canonicalLineage, nablaLabel, type NablaLabel } from "../labels";
import { IdentityRegistryAbi } from "../external-abis";
import {
  FEEDBACK_URI_NOT_READ,
  GROUNDING_SOURCE,
  cShare,
  controllerAt,
  creditLineFacts,
  groundingFact,
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
  type GroundingPayment,
  type Payment,
} from "../read";

const app = new Hono();

const lc = (a: string) => a.toLowerCase() as Hex;
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function indexedBlock(origin: string, chain: EnabledChain): Promise<bigint | null> {
  const r = await fetch(new URL("/status", origin));
  if (!r.ok) return null;
  const s = (await r.json()) as Record<string, { block: { number: number } }>;
  const n = s[chain.name]?.block.number;
  return n === undefined ? null : BigInt(n);
}

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

/** getAgentWallet(agentId) at a block; the zero address reads as null. */
async function walletAt(client: PublicClient, registry: Address, agentId: bigint, blockNumber: bigint): Promise<Address | null> {
  const w = await client.readContract({ address: registry, abi: IdentityRegistryAbi, functionName: "getAgentWallet", args: [agentId], blockNumber });
  return w === "0x0000000000000000000000000000000000000000" ? null : getAddress(w);
}

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

  // ERC-8004 feedback grounding (R-D2B-2): when the subject has been the agentWallet of an indexed agentId.
  const external = sourcesOn().has("external");
  const walletRows = external
    ? await db
        .selectDistinct({ agentId: agentWallets.agentId })
        .from(agentWallets)
        .where(and(eq(agentWallets.chainId, chainId), isNotNull(agentWallets.wallet), eq(agentWallets.wallet, a)))
    : [];
  const agentIds = walletRows.map((w) => w.agentId);
  const fbs = agentIds.length
    ? await db.select().from(feedbacks).where(and(eq(feedbacks.chainId, chainId), inArray(feedbacks.agentId, agentIds)))
    : [];
  const groundingFacts: Fact[] = [];
  if (fbs.length) {
    // Candidate payments into the subject: vault settlements (labelled by the paying account) and external payments.
    const candidates: GroundingPayment[] = [];
    if (hasNabla(chain) && sourcesOn().has("nabla")) {
      const vin = await db.select().from(vaultPayments).where(and(eq(vaultPayments.chainId, chainId), eq(vaultPayments.payee, a)));
      const labels = new Map<string, NablaLabel>();
      for (const v of vin) {
        const acc = lc(v.account);
        if (!labels.has(acc)) labels.set(acc, await nablaLabelOf(client, chain as never, acc, asOfBlock));
        const [fact] = vaultPaymentFacts([v], labels.get(acc)!);
        candidates.push({ fact: fact!, payer: getAddress(v.account), payee: getAddress(v.payee!), block: v.blockNumber, logIndex: v.logIndex });
      }
    }
    const pin = pays.filter((p) => lc(p.payee) === a);
    paymentFacts(pin, permById).forEach((fact, i) =>
      candidates.push({ fact, payer: getAddress(pin[i]!.payer), payee: getAddress(pin[i]!.payee), block: pin[i]!.blockNumber, logIndex: pin[i]!.logIndex }),
    );
    // Every payment source this instance reads is indexed from the latest of their start blocks.
    const starts = [externalStart(chain, "SpendPermissionManager"), externalStart(chain, "DelegationManager")];
    if (hasNabla(chain) && sourcesOn().has("nabla")) starts.push(nablaStart(chain)!);
    const paymentsFrom = Math.max(...starts);
    const controllerOf = async (who: Hex, block: bigint) => {
      if (!hasNabla(chain)) return null;
      const [isAccount] = await db.select().from(accounts).where(eq(accounts.id, `${chainId}-${who}`));
      if (!isAccount) return null;
      const ok = canonicalLineage({ implementations: await implementationsOf(chainId, who) }).ok;
      return controllerAt(getAddress(who), block, await controllerInput(chainId, who, ok));
    };
    const wallets = new Map<string, Promise<Address | null>>();
    const readWallet = (agentId: bigint, block: bigint) => {
      const k = `${agentId}-${block}`;
      if (!wallets.has(k)) wallets.set(k, walletAt(client, chain.external.IdentityRegistry, agentId, block));
      return wallets.get(k)!;
    };
    for (const f of fbs) {
      let wallet: { before: Address | null; at: Address | null } | { error: string };
      try {
        wallet = { before: await readWallet(f.agentId, f.blockNumber - 1n), at: await readWallet(f.agentId, f.blockNumber) };
      } catch (e) {
        wallet = { error: String((e as Error).message ?? e).split("\n")[0]! };
      }
      const g = groundingFact({
        subject,
        feedback: f,
        wallet,
        payments: candidates,
        paymentsFrom,
        raterController: await controllerOf(lc(f.client), f.blockNumber),
        subjectController: await controllerOf(a, f.blockNumber),
      });
      if (g) groundingFacts.push(g);
    }
    notes.push(FEEDBACK_URI_NOT_READ);
    for (const g of groundingFacts) {
      const t = g.terms as { grounding: string; reason?: string; agentId: string };
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
  return c.body(json({ subject, chainId, asOfBlock, facts, selfDealing: selfDealingOut, exposure: exposureOut, cShare: cShareOut, notes }), 200, {
    "content-type": "application/json",
  });
});

export default app;
