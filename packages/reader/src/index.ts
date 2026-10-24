import { and, desc, eq } from "ponder";
import { ponder, type Context } from "ponder:registry";
import {
  accounts,
  counterparties,
  grants,
  implementationHistory,
  obligationPairs,
  recordEntries,
  vaultFundings,
  vaultPayments,
  vaults,
} from "ponder:schema";
import { getAddress, type Address, type Hex } from "viem";
import { chainById } from "./chains";
import {
  COUNTERPARTY_KINDS,
  DEPENDENCY_FIELD_MANDATE,
  ENVELOPE_LABEL,
  OBLIGATION_KINDS,
  TRANSFER_TOPIC,
  ZERO32,
  bytes32ToAddress,
  callsForSettlement,
  castEnvelopeOf,
  castLogs,
  ethGetLogs,
  granteeKeyOf,
  kindName,
  obligationRole,
  pairTransfer,
  predictVault,
  resolveEnvelope,
  rowId,
  vaultSettlementsInReceipt,
  type EnvelopeRead,
  type ReceiptLog,
} from "./derive";
import { ConsumerAIMandateV4Abi } from "@nablaz/sdk/abis";

const lc = (a: string) => a.toLowerCase() as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type LogLike = { address: Address; topics: readonly Hex[]; logIndex: number };
type BlockLike = { number: bigint; timestamp: bigint };

function evidence(chainId: number, block: BlockLike, txHash: Hex, log: LogLike) {
  // Ponder pads topics to four with nulls.
  const topics = log.topics.filter((t): t is Hex => typeof t === "string");
  return {
    chainId,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    txHash,
    logIndex: log.logIndex,
    reproduce: castLogs(block.number, log.address, topics),
    reproduceGetLogs: ethGetLogs(block.number, log.address, topics),
  };
}

async function receiptLogs(context: Context, hash: Hex): Promise<ReceiptLog[]> {
  const r = await context.client.getTransactionReceipt({ hash });
  return r.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data, logIndex: l.logIndex }));
}

async function noteCounterparty(
  context: Context,
  ev: ReturnType<typeof evidence>,
  subject: Address,
  counterparty: Address,
  from: "record_entry" | "vault_payment",
  evidenceId: string,
) {
  if (lc(counterparty) === ZERO_ADDRESS) return;
  const id = `${ev.chainId}-${lc(subject)}-${lc(counterparty)}`;
  const row = await context.db.find(counterparties, { id });
  const isEntry = from === "record_entry" ? 1 : 0;
  if (!row) {
    await context.db.insert(counterparties).values({
      id,
      ...ev,
      subject,
      counterparty,
      firstEvidence: from,
      firstEvidenceId: evidenceId,
      recordEntryCount: isEntry,
      vaultSettlementCount: 1 - isEntry,
    });
  } else {
    await context.db.update(counterparties, { id }).set({
      recordEntryCount: row.recordEntryCount + isEntry,
      vaultSettlementCount: row.vaultSettlementCount + (1 - isEntry),
    });
  }
}

// ── Account discovery ───────────────────────────────────────────────

async function noteAccount(
  context: Context,
  ev: ReturnType<typeof evidence>,
  a: { account: Address; accountId: Hex; owner: Address },
  via: "factory" | "registry",
) {
  const id = `${ev.chainId}-${lc(a.account)}`;
  const row = await context.db.find(accounts, { id });
  if (!row) {
    await context.db
      .insert(accounts)
      .values({ id, ...ev, ...a, viaFactory: via === "factory", viaRegistry: via === "registry" });
  } else {
    await context.db
      .update(accounts, { id })
      .set(via === "factory" ? { viaFactory: true } : { viaRegistry: true });
  }
}

ponder.on("AccountFactory:AccountCreated", async ({ event, context }) => {
  const ev = evidence(context.chain.id, event.block, event.transaction.hash, event.log);
  const { account, accountId, owner } = event.args;
  await noteAccount(context, ev, { account, accountId, owner }, "factory");
});

ponder.on("AccountRegistry:AccountCreated", async ({ event, context }) => {
  const ev = evidence(context.chain.id, event.block, event.transaction.hash, event.log);
  const { account, accountId, safe } = event.args;
  await noteAccount(context, ev, { account, accountId, owner: safe }, "registry");
});

// ── implementation_history: ERC-1967 Upgraded ───────────────────────

async function onUpgraded(event: any, context: Context) {
  const ev = evidence(context.chain.id, event.block, event.transaction.hash, event.log);
  await context.db
    .insert(implementationHistory)
    .values({
      id: rowId(ev.chainId, ev.txHash, ev.logIndex),
      ...ev,
      account: event.log.address,
      source: "Upgraded",
      implementation: event.args.implementation,
    })
    // The same proxy log arrives from both discovery sources.
    .onConflictDoNothing();
}

ponder.on("AccountProxyViaFactory:Upgraded", async ({ event, context }) => onUpgraded(event, context));
ponder.on("AccountProxyViaRegistry:Upgraded", async ({ event, context }) => onUpgraded(event, context));

// ── record_entries and what derives from them ───────────────────────

ponder.on("NablaRecord:RecordEntry", async ({ event, context }) => {
  const chainId = context.chain.id;
  const ev = evidence(chainId, event.block, event.transaction.hash, event.log);
  const id = rowId(chainId, ev.txHash, ev.logIndex);
  const a = event.args;
  const name = kindName(a.kind);

  await context.db.insert(recordEntries).values({
    id,
    ...ev,
    emitter: event.log.address,
    subject: a.subject,
    kind: a.kind,
    kindName: name,
    writer: a.writer,
    writerAuth: a.writerAuth,
    counterparty: a.counterparty,
    counterpartyAuth: a.counterpartyAuth,
    policyHash: a.policyHash,
    policyVersion: BigInt(a.policyVersion),
    asset: a.asset,
    amount: a.amount,
    amountCommitment: a.amountCommitment,
    obligationRef: a.obligationRef,
    source: a.source,
    time: a.time,
    seq: a.seq,
    submitter: event.transaction.from,
  });

  if (name === null) return;

  if (OBLIGATION_KINDS.has(name)) {
    const role = obligationRole(name)!;
    let openedEntryId: string | null = null;
    if (role === "OPENED") openedEntryId = id;
    else if (lc(a.obligationRef) !== ZERO32) {
      const [opened] = await context.db.sql
        .select({ id: obligationPairs.id })
        .from(obligationPairs)
        .where(
          and(
            eq(obligationPairs.chainId, chainId),
            eq(obligationPairs.obligationRef, lc(a.obligationRef)),
            eq(obligationPairs.role, "OPENED"),
          ),
        )
        .limit(1);
      openedEntryId = opened?.id ?? null;
    }
    await context.db.insert(obligationPairs).values({
      id,
      ...ev,
      subject: a.subject,
      obligationRef: a.obligationRef,
      role,
      openedEntryId,
      counterparty: a.counterparty,
      asset: a.asset,
      amount: a.amount,
      time: a.time,
    });
  }

  if (COUNTERPARTY_KINDS.has(name)) {
    await noteCounterparty(context, ev, a.subject, a.counterparty, "record_entry", id);
  }

  if (name === "IMPLEMENTATION_CHANGED") {
    await context.db.insert(implementationHistory).values({
      id,
      ...ev,
      account: a.subject,
      source: "IMPLEMENTATION_CHANGED",
      implementation: a.counterparty,
    });
  }

  if (name === "GRANT_SET") {
    const gid = `${chainId}-${lc(a.subject)}-${lc(a.writerAuth)}`;
    const agentId = BigInt(a.counterpartyAuth);
    const values = {
      ...ev,
      subject: a.subject,
      grantId: a.writerAuth,
      grantee: a.counterparty,
      agentId,
      granteeKey: granteeKeyOf(a.counterparty, agentId),
      policyHash: a.policyHash,
      policyVersion: BigInt(a.policyVersion),
    };
    await context.db
      .insert(grants)
      .values({ id: gid, ...values })
      .onConflictDoUpdate(values);
  }

  if (name === "PAY_AUTHORIZED") await onPayAuthorized(context, ev, id, event.args);
});

/** P0-4: the vault from logs alone — PAY_AUTHORIZED.counterpartyAuth, the funding Transfer, CREATE2. */
async function onPayAuthorized(
  context: Context,
  ev: ReturnType<typeof evidence>,
  entryId: string,
  a: {
    subject: Address;
    writerAuth: Hex;
    counterparty: Address;
    counterpartyAuth: Hex;
    policyHash: Hex;
    policyVersion: number;
    asset: Address;
    amount: bigint;
  },
) {
  const chain = chainById(ev.chainId);
  const vault = bytes32ToAddress(a.counterpartyAuth);
  const token = getAddress(a.asset);

  const logs = await receiptLogs(context, ev.txHash);
  const fundingTransferSeen = logs.some(
    (l) =>
      lc(l.address) === lc(token) &&
      l.topics[0] === TRANSFER_TOPIC &&
      lc(bytes32ToAddress(l.topics[1]!)) === lc(a.subject) &&
      lc(bytes32ToAddress(l.topics[2]!)) === lc(vault),
  );

  const grant = await context.db.find(grants, { id: `${ev.chainId}-${lc(a.subject)}-${lc(a.writerAuth)}` });
  const granteeKey = grant?.granteeKey ?? null;
  const create2Matches =
    granteeKey === null ? null : lc(predictVault(chain.contracts.GranteeVault, a.subject, granteeKey)) === lc(vault);

  const vid = `${ev.chainId}-${lc(vault)}`;
  if (!(await context.db.find(vaults, { id: vid }))) {
    await context.db.insert(vaults).values({
      id: vid,
      ...ev,
      vault,
      account: a.subject,
      grantee: a.counterparty,
      granteeKey,
      create2Matches,
      fundingTransferSeen,
    });
  }

  const fid = `${ev.chainId}-${lc(vault)}-${lc(token)}`;
  const prev = await context.db.find(vaultFundings, { id: fid });
  const values = {
    ...ev,
    vault,
    token,
    account: a.subject,
    grantId: a.writerAuth,
    policyHash: a.policyHash,
    policyVersion: BigInt(a.policyVersion),
    amount: a.amount,
    fundingEntryId: entryId,
    fundingCount: (prev?.fundingCount ?? 0) + 1,
  };
  if (prev) await context.db.update(vaultFundings, { id: fid }).set(values);
  else await context.db.insert(vaultFundings).values({ id: fid, ...values });
}

// ── vault_payments: AuthorizationUsed(authorizer = vault) + Transfer ─

ponder.on("Usdc:AuthorizationUsed", async ({ event, context }) => {
  const chainId = context.chain.id;
  const authorizer = event.args.authorizer;
  const vault = await context.db.find(vaults, { id: `${chainId}-${lc(authorizer)}` });
  if (!vault) return; // not a grantee vault

  const chain = chainById(chainId);
  const token = event.log.address;
  const ev = evidence(chainId, event.block, event.transaction.hash, event.log);
  const id = rowId(chainId, ev.txHash, ev.logIndex);
  const logs = await receiptLogs(context, ev.txHash);

  // P0-1 pairing.
  const transfer = pairTransfer(logs, token, vault.vault, ev.logIndex);

  // R-D2B-6: settlements counted per AuthorizationUsed log; batch position within the tx.
  const authorizers = new Set<string>();
  for (const l of logs) if (l.topics[1]) authorizers.add(lc(bytes32ToAddress(l.topics[1])));
  const known = new Set<string>();
  for (const x of authorizers) if (await context.db.find(vaults, { id: `${chainId}-${x}` })) known.add(x);
  const inTx = vaultSettlementsInReceipt(logs, token, (x) => known.has(lc(x)));
  const recordEntriesForAccount = logs.filter(
    (l) =>
      lc(l.address) === lc(chain.contracts.NablaRecord) &&
      l.topics[1] !== undefined &&
      lc(bytes32ToAddress(l.topics[1])) === lc(vault.account),
  ).length;

  // Grant from logs: the latest PAY_AUTHORIZED for this vault and token.
  const funding = await context.db.find(vaultFundings, { id: `${chainId}-${lc(vault.vault)}-${lc(token)}` });

  // R-S184-2 / R-B0-1: the envelope expiry comes from envelopeOf at the settlement block, never from entries.
  // Read at N−1 and N; the mandate is the account's latest DEPENDENCY_SET (field 0), else the canonical CAM V4.
  const [dep] = await context.db.sql
    .select({ counterparty: recordEntries.counterparty })
    .from(recordEntries)
    .where(
      and(
        eq(recordEntries.chainId, chainId),
        eq(recordEntries.subject, lc(vault.account)),
        eq(recordEntries.kindName, "DEPENDENCY_SET"),
        eq(recordEntries.writerAuth, DEPENDENCY_FIELD_MANDATE),
      ),
    )
    .orderBy(desc(recordEntries.blockNumber), desc(recordEntries.logIndex))
    .limit(1);
  const mandate = getAddress(dep?.counterparty ?? chain.contracts.ConsumerAIMandateV4);

  let envelope: Record<string, unknown> = {
    envelopeMandate: mandate,
    envelopeStatus: "not determinable: vault's grantee key not seen in GRANT_SET",
    envelopeGrantId: null,
    envelopeExpiry: null,
  };
  if (vault.granteeKey) {
    const n = event.block.number;
    const read = async (blockNumber: bigint): Promise<EnvelopeRead> => {
      const [grantId, expiry] = await context.client.readContract({
        abi: ConsumerAIMandateV4Abi,
        address: mandate,
        functionName: "envelopeOf",
        args: [vault.account, vault.granteeKey!, token],
        blockNumber,
      });
      return { grantId, expiry: BigInt(expiry) };
    };
    const atPrev = await read(n - 1n);
    const atBlock = await read(n);
    const resolved = resolveEnvelope(atPrev, atBlock);
    envelope = {
      envelopeMandate: mandate,
      ...resolved,
      envelopeAtPrevGrantId: atPrev.grantId,
      envelopeAtPrevExpiry: atPrev.expiry,
      envelopeAtBlockGrantId: atBlock.grantId,
      envelopeAtBlockExpiry: atBlock.expiry,
      reproduceEnvelopeAtPrev: castEnvelopeOf(n - 1n, mandate, vault.account, vault.granteeKey, token),
      reproduceEnvelopeAtBlock: castEnvelopeOf(n, mandate, vault.account, vault.granteeKey, token),
      grantMatchesEnvelope:
        resolved.envelopeGrantId === null || !funding ? null : lc(resolved.envelopeGrantId) === lc(funding.grantId),
    };
  }

  await context.db.insert(vaultPayments).values({
    id,
    ...ev,
    token,
    vault: vault.vault,
    account: vault.account,
    grantee: vault.grantee,
    nonce: event.args.nonce,
    transferLogIndex: transfer?.logIndex ?? null,
    reproduceTransfer: transfer ? castLogs(ev.blockNumber, token, transfer.topics) : null,
    payee: transfer?.to ?? null,
    value: transfer?.value ?? null,
    submitter: event.transaction.from,
    grantIdFromLogs: funding?.grantId ?? null,
    fundingEntryId: funding?.fundingEntryId ?? null,
    policyHash: funding?.policyHash ?? null,
    policyVersion: funding?.policyVersion ?? null,
    envelopeLabel: ENVELOPE_LABEL,
    ...(envelope as { envelopeStatus: string }),
    settlements: 1,
    settlementOrdinalInTx: inTx.indexOf(ev.logIndex),
    settlementsInTx: inTx.length,
    ...callsForSettlement(recordEntriesForAccount),
  });

  if (transfer) await noteCounterparty(context, ev, vault.account, transfer.to, "vault_payment", id);
});
