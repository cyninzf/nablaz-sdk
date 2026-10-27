// Handlers for the third-party sources (s3 §6.4c): Coinbase SpendPermissionManager, MetaMask
// DelegationManager, Agent Credit Lines. Labels from src/labels.ts; the reproduce column from src/oneliners.ts.

import { ponder, type Context } from "ponder:registry";
import { agentWallets, creditLineEvents, externalPayments, externalPermissions, externalRedemptions, feedbacks } from "ponder:schema";
import { getAddress, size, type Address, type Hex } from "viem";
import { chainById } from "./chains";
import { delegationHash, erc20TransfersFrom, hopOf, type Delegation, type ReceiptLogLike } from "./delegation";
import { ethGetLogs, rowId } from "./derive";
import { SPM_LABEL, attestationLabel, shapeJson, shapeOfDelegation } from "./labels";
import { AGENT_WALLET_KEY_TOPIC, render } from "./oneliners";

type LogLike = { address: Address; topics: readonly (Hex | null)[]; logIndex: number };
type BlockLike = { number: bigint; timestamp: bigint };

function evidence(chainId: number, block: BlockLike, txHash: Hex, log: LogLike, reproduce: string) {
  const topics = log.topics.filter((t): t is Hex => typeof t === "string");
  return {
    chainId,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    txHash,
    logIndex: log.logIndex,
    reproduce,
    reproduceGetLogs: ethGetLogs(block.number, log.address, topics),
  };
}

const lc = (a: string) => a.toLowerCase() as Hex;
const json = (x: unknown) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

// ── SpendPermissionManager (s3 §6.4b (4)) ───────────────────────────

type SpendPermissionArgs = {
  account: Address;
  spender: Address;
  token: Address;
  allowance: bigint;
  period: number;
  start: number;
  end: number;
};

const spmTerms = (p: SpendPermissionArgs) => ({
  allowance: p.allowance.toString(),
  period: p.period,
  start: p.start,
  end: p.end,
  token: p.token,
});

async function onSpmApprovedOrRevoked(event: any, context: Context, status: "approved" | "revoked") {
  const chainId = context.chain.id;
  const p = event.args.spendPermission as SpendPermissionArgs;
  const from = chainById(chainId).external.startBlocks.SpendPermissionManager;
  const ev = evidence(chainId, event.block, event.transaction.hash, event.log, render(status === "approved" ? "4-spm-approved" : "4-spm-revoked", { chainId, account: p.account, from }));
  const id = `${chainId}-spm-${lc(event.args.hash)}`;
  const row = await context.db.find(externalPermissions, { id });
  if (row) {
    await context.db.update(externalPermissions, { id }).set({ status, terms: spmTerms(p) });
    return;
  }
  await context.db.insert(externalPermissions).values({
    id,
    ...ev,
    source: "spm",
    subject: p.account,
    grantee: p.spender,
    permissionId: event.args.hash,
    shape: "a",
    label: SPM_LABEL,
    terms: spmTerms(p),
    status,
    useCount: 0,
  });
}

ponder.on("SpendPermissionManager:SpendPermissionApproved", async ({ event, context }) => onSpmApprovedOrRevoked(event, context, "approved"));
ponder.on("SpendPermissionManager:SpendPermissionRevoked", async ({ event, context }) => onSpmApprovedOrRevoked(event, context, "revoked"));

ponder.on("SpendPermissionManager:SpendPermissionUsed", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { hash, account, spender, token, periodSpend } = event.args;
  const from = chainById(chainId).external.startBlocks.SpendPermissionManager;
  const ev = evidence(chainId, event.block, event.transaction.hash, event.log, render("4-spm-used", { chainId, account, from }));
  const id = `${chainId}-spm-${lc(hash)}`;
  const row = await context.db.find(externalPermissions, { id });
  if (row) {
    await context.db.update(externalPermissions, { id }).set({ useCount: row.useCount + 1 });
  } else {
    // The approval predates the indexed range: the shape is (a) by construction, the terms are not seen.
    await context.db.insert(externalPermissions).values({
      id,
      ...ev,
      source: "spm",
      subject: account,
      grantee: spender,
      permissionId: hash,
      shape: "a",
      label: SPM_LABEL,
      terms: { token, allowance: null, period: null, note: "SpendPermissionApproved not in the indexed range" },
      status: "observed-by-use-only",
      useCount: 1,
    });
  }
  await context.db
    .insert(externalPayments)
    .values({
      id: rowId(chainId, ev.txHash, ev.logIndex),
      ...ev,
      source: "spm",
      payer: account,
      payee: spender,
      token,
      amount: BigInt(periodSpend.spend),
      permissionId: hash,
      redemptionTx: null,
      redemptionLogIndex: null,
    })
    .onConflictDoNothing();
});

// ── DelegationManager (s3 §6.4b (5), R-S189-5) ──────────────────────

ponder.on("DelegationManager:RedeemedDelegation", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { rootDelegator, redeemer } = event.args;
  const d = event.args.delegation as unknown as Delegation;
  const hash = delegationHash(d);
  const shape = shapeOfDelegation(d.caveats);
  const from = chainById(chainId).external.startBlocks.DelegationManager;
  const ev = evidence(chainId, event.block, event.transaction.hash, event.log, render("5-redeemed-delegation", { chainId, rootDelegator, from }));

  // A redemption is not a payment. Only an ERC-20 Transfer from the delegator, or the root delegator, in the
  // same tx is. The manager emits one event per hop with the root as topic1, so each Transfer is written
  // once: by the hop whose delegator sent it.
  const receipt = await context.client.getTransactionReceipt({ hash: ev.txHash });
  const logs: ReceiptLogLike[] = receipt.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data, logIndex: l.logIndex }));
  const fromEither = erc20TransfersFrom(logs, [d.delegator, rootDelegator]);
  const fromThisHop = fromEither.filter((t) => lc(t.from) === lc(d.delegator));

  const enforcers = json(shape.enforcers);
  await context.db.insert(externalRedemptions).values({
    id: rowId(chainId, ev.txHash, ev.logIndex),
    ...ev,
    rootDelegator,
    redeemer,
    delegate: d.delegate,
    delegator: d.delegator,
    authority: d.authority,
    hop: hopOf(d),
    delegationHash: hash,
    enforcers,
    shape: shape.shape,
    label: shape.label,
    hadTransfer: fromEither.length > 0,
  });

  const pid = `${chainId}-dm-${hash}`;
  const row = await context.db.find(externalPermissions, { id: pid });
  if (row) await context.db.update(externalPermissions, { id: pid }).set({ useCount: row.useCount + 1 });
  else
    await context.db.insert(externalPermissions).values({
      id: pid,
      ...ev,
      source: "delegation_manager",
      subject: d.delegator,
      grantee: d.delegate,
      permissionId: hash,
      shape: shape.shape,
      label: shape.label,
      terms: { ...shapeJson(shape), enforcers, authority: d.authority, rootDelegator },
      // A delegation is signed off chain; the chain shows it only when redeemed.
      status: "observed-by-use-only",
      useCount: 1,
    });

  for (const t of fromThisHop) {
    const tLog = logs.find((l) => l.logIndex === t.logIndex)!;
    await context.db
      .insert(externalPayments)
      .values({
        id: rowId(chainId, ev.txHash, t.logIndex),
        ...evidence(chainId, event.block, ev.txHash, tLog, render("5-delegator-transfer", { chainId, tx: ev.txHash, rootDelegator: t.from })),
        source: "delegation_manager",
        payer: t.from,
        payee: t.to,
        token: t.token,
        amount: t.amount,
        permissionId: hash,
        redemptionTx: ev.txHash,
        redemptionLogIndex: ev.logIndex,
      })
      .onConflictDoNothing();
  }
});

// ── Agent Credit Lines (s3 §6.4b (6), R-S189-6) ─────────────────────

async function onCreditLine(event: any, context: Context, kind: "borrowed" | "repaid" | "defaulted") {
  const chainId = context.chain.id;
  const a = event.args;
  const lender = event.log.address as Address;
  const from = chainById(chainId).external.startBlocks.creditLineLenders;
  const line = kind === "borrowed" ? "6-borrowed" : kind === "repaid" ? "6-repaid" : "6-defaulted";
  const ev = evidence(chainId, event.block, event.transaction.hash, event.log, render(line, { chainId, lender, agentId: a.agentId.toString(), from }));
  await context.db.insert(creditLineEvents).values({
    id: rowId(chainId, ev.txHash, ev.logIndex),
    ...ev,
    lender,
    agentId: a.agentId,
    loanId: a.loanId,
    kind,
    party: kind === "borrowed" ? a.to : kind === "repaid" ? a.payer : a.owner,
    principal: a.principal,
    fee: kind === "defaulted" ? null : a.fee,
    dueAt: kind === "borrowed" ? BigInt(a.dueAt) : null,
    label: attestationLabel(lender),
  });
}

ponder.on("CreditLine:Borrowed", async ({ event, context }) => onCreditLine(event, context, "borrowed"));
ponder.on("CreditLine:Repaid", async ({ event, context }) => onCreditLine(event, context, "repaid"));
ponder.on("CreditLine:Defaulted", async ({ event, context }) => onCreditLine(event, context, "defaulted"));

// ── ERC-8004 (s3 §6.4b (7), (10); R-D2B-2) ──────────────────────────

// Only who rated which agentId, and where. value, valueDecimals, tags, endpoint, feedbackURI and feedbackHash
// are decoded by the ABI and dropped here: never stored, never output.
ponder.on("ReputationRegistry:NewFeedback", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { agentId, clientAddress, feedbackIndex } = event.args;
  const from = chainById(chainId).external.startBlocks.ReputationRegistry;
  const ev = evidence(chainId, event.block, event.transaction.hash, event.log, render("7-new-feedback", { chainId, agentId: agentId.toString(), from }));
  await context.db.insert(feedbacks).values({ id: rowId(chainId, ev.txHash, ev.logIndex), ...ev, agentId, client: clientAddress, feedbackIndex: BigInt(feedbackIndex) });
});

ponder.on("IdentityRegistry:MetadataSet", async ({ event, context }) => {
  if (event.log.topics[2]?.toLowerCase() !== AGENT_WALLET_KEY_TOPIC) return;
  const chainId = context.chain.id;
  const { agentId, metadataValue } = event.args;
  const from = chainById(chainId).external.startBlocks.IdentityRegistry;
  const ev = evidence(chainId, event.block, event.transaction.hash, event.log, render("10-agentwallet-history", { chainId, agentId: agentId.toString(), from }));
  // abi.encodePacked(address): 20 bytes; empty bytes clear the wallet (IdentityRegistryUpgradeable :177-178, :194-195).
  const wallet = size(metadataValue) === 20 ? getAddress(metadataValue) : null;
  await context.db.insert(agentWallets).values({ id: rowId(chainId, ev.txHash, ev.logIndex), ...ev, agentId, wallet });
});
