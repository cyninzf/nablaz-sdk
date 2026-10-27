import { index, onchainTable, type PgColumnsBuilders } from "ponder";

// Every row carries chainId, block, tx hash, log index and the command that reproduces it. Rows hold
// facts and counts only.

const evidence = (t: PgColumnsBuilders) => ({
  chainId: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  logIndex: t.integer().notNull(),
  /** `cast logs` for this row's log. */
  reproduce: t.text().notNull(),
  /** The same query as a raw eth_getLogs request body. */
  reproduceGetLogs: t.text().notNull(),
});

/** Every RecordEntry, raw: every field of the event. */
export const recordEntries = onchainTable(
  "record_entries",
  (t) => ({
    id: t.text().primaryKey(),
    ...evidence(t),
    emitter: t.hex().notNull(),
    subject: t.hex().notNull(),
    kind: t.hex().notNull(),
    /** The kind's name if the hash is a known kind, else null. */
    kindName: t.text(),
    writer: t.hex().notNull(),
    writerAuth: t.hex().notNull(),
    counterparty: t.hex().notNull(),
    counterpartyAuth: t.hex().notNull(),
    policyHash: t.hex().notNull(),
    policyVersion: t.bigint().notNull(),
    asset: t.hex().notNull(),
    amount: t.bigint().notNull(),
    amountCommitment: t.hex().notNull(),
    obligationRef: t.hex().notNull(),
    source: t.hex().notNull(),
    time: t.bigint().notNull(),
    seq: t.bigint().notNull(),
    /** tx.from of the transaction that carried the entry. */
    submitter: t.hex().notNull(),
  }),
  (t) => ({ bySubject: index().on(t.chainId, t.subject, t.seq) }),
);

/** OBLIGATION_OPENED / REPAY / OBLIGATION_CLOSED, one row per entry, grouped by obligationRef. */
export const obligationPairs = onchainTable(
  "obligation_pairs",
  (t) => ({
    id: t.text().primaryKey(),
    ...evidence(t),
    subject: t.hex().notNull(),
    obligationRef: t.hex().notNull(),
    role: t.text().notNull(), // OPENED | REPAY | CLOSED
    /** record_entries.id of the OBLIGATION_OPENED this entry belongs to; null if not seen or ref is 0. */
    openedEntryId: t.text(),
    counterparty: t.hex().notNull(),
    asset: t.hex().notNull(),
    amount: t.bigint().notNull(),
    time: t.bigint().notNull(),
  }),
  (t) => ({ byRef: index().on(t.chainId, t.obligationRef) }),
);

/** Accounts, from NablaAccountFactoryPermanent and AccountRegistryV6 AccountCreated. */
export const accounts = onchainTable("accounts", (t) => ({
  id: t.text().primaryKey(), // chainId-account
  ...evidence(t), // first AccountCreated seen
  account: t.hex().notNull(),
  accountId: t.hex().notNull(),
  owner: t.hex().notNull(),
  viaFactory: t.boolean().notNull(),
  viaRegistry: t.boolean().notNull(),
}));

/** GRANT_SET per (subject, grantId): the grantee and the vault key derived from it. */
export const grants = onchainTable("grants", (t) => ({
  id: t.text().primaryKey(), // chainId-subject-grantId
  ...evidence(t), // latest GRANT_SET
  subject: t.hex().notNull(),
  grantId: t.hex().notNull(),
  grantee: t.hex().notNull(),
  agentId: t.bigint().notNull(),
  granteeKey: t.hex().notNull(),
  policyHash: t.hex().notNull(),
  policyVersion: t.bigint().notNull(),
}));

/** Grantee vaults, discovered from logs alone (P0-4): PAY_AUTHORIZED.counterpartyAuth plus the funding Transfer. */
export const vaults = onchainTable("vaults", (t) => ({
  id: t.text().primaryKey(), // chainId-vault
  ...evidence(t), // first PAY_AUTHORIZED naming it
  vault: t.hex().notNull(),
  account: t.hex().notNull(),
  grantee: t.hex().notNull(),
  /** From the GRANT_SET of the funding grant; null if that GRANT_SET was not seen. */
  granteeKey: t.hex(),
  /** CREATE2 prediction from the logged (account, granteeKey) equals the vault. Null if no key. */
  create2Matches: t.boolean(),
  /** A Transfer(account → vault) sits in the same tx as the PAY_AUTHORIZED. */
  fundingTransferSeen: t.boolean().notNull(),
}));

/** Latest PAY_AUTHORIZED per (vault, token): what a later settlement is paired to from logs. */
export const vaultFundings = onchainTable("vault_fundings", (t) => ({
  id: t.text().primaryKey(), // chainId-vault-token
  ...evidence(t),
  vault: t.hex().notNull(),
  token: t.hex().notNull(),
  account: t.hex().notNull(),
  grantId: t.hex().notNull(),
  policyHash: t.hex().notNull(),
  policyVersion: t.bigint().notNull(),
  amount: t.bigint().notNull(),
  fundingEntryId: t.text().notNull(),
  fundingCount: t.integer().notNull(),
}));

/** One row per settlement: USDC AuthorizationUsed(authorizer = vault) paired with its Transfer. */
export const vaultPayments = onchainTable(
  "vault_payments",
  (t) => ({
    id: t.text().primaryKey(), // chainId-tx-authorizationUsedLogIndex
    ...evidence(t), // the AuthorizationUsed log
    token: t.hex().notNull(),
    vault: t.hex().notNull(),
    account: t.hex().notNull(),
    grantee: t.hex().notNull(),
    nonce: t.hex().notNull(),
    /** Transfer(vault → payee) paired to the AuthorizationUsed (P0-1). */
    transferLogIndex: t.integer(),
    reproduceTransfer: t.text(),
    payee: t.hex(),
    value: t.bigint(),
    /** tx.from. The party that submitted the settlement; never the counterparty. */
    submitter: t.hex().notNull(),

    // Grant, from logs: the latest PAY_AUTHORIZED for this vault and token before the settlement.
    grantIdFromLogs: t.hex(),
    fundingEntryId: t.text(),
    policyHash: t.hex(),
    policyVersion: t.bigint(),

    // R-S184-2 + R-B0-1: envelopeOf(account, granteeKey, token) read at N−1 and N, never inferred from
    // entries. This is the only field that needs state.
    envelopeLabel: t.text().notNull(),
    envelopeMandate: t.hex(),
    envelopeStatus: t.text().notNull(), // "determinate" | "not determinable (...)"
    envelopeGrantId: t.hex(),
    envelopeExpiry: t.bigint(),
    envelopeAtPrevGrantId: t.hex(),
    envelopeAtPrevExpiry: t.bigint(),
    envelopeAtBlockGrantId: t.hex(),
    envelopeAtBlockExpiry: t.bigint(),
    reproduceEnvelopeAtPrev: t.text(),
    reproduceEnvelopeAtBlock: t.text(),
    /** The envelope's grant equals the grant from logs. False flags an envelope re-funded without an entry. */
    grantMatchesEnvelope: t.boolean(),

    // R-D2B-6 batch-aware counts.
    settlements: t.integer().notNull(), // always 1: one per AuthorizationUsed log
    settlementOrdinalInTx: t.integer().notNull(), // 0-based among vault settlements in this tx
    settlementsInTx: t.integer().notNull(),
    calls: t.bigint(),
    callsStatus: t.text().notNull(),
  }),
  (t) => ({ byAccount: index().on(t.chainId, t.account) }),
);

/** Implementation per account: ERC-1967 Upgraded on the proxy and the record's IMPLEMENTATION_CHANGED. */
export const implementationHistory = onchainTable(
  "implementation_history",
  (t) => ({
    id: t.text().primaryKey(),
    ...evidence(t),
    account: t.hex().notNull(),
    source: t.text().notNull(), // "Upgraded" | "IMPLEMENTATION_CHANGED"
    implementation: t.hex().notNull(),
  }),
  (t) => ({ byAccount: index().on(t.chainId, t.account) }),
);

/** Distinct counterparties per subject, with first evidence and counts. */
export const counterparties = onchainTable(
  "counterparties",
  (t) => ({
    id: t.text().primaryKey(), // chainId-subject-counterparty
    ...evidence(t), // first evidence
    subject: t.hex().notNull(),
    counterparty: t.hex().notNull(),
    firstEvidence: t.text().notNull(), // "record_entry" | "vault_payment"
    firstEvidenceId: t.text().notNull(),
    recordEntryCount: t.integer().notNull(),
    vaultSettlementCount: t.integer().notNull(),
  }),
  (t) => ({ bySubject: index().on(t.chainId, t.subject) }),
);

// ── B4 part 1: external sources (s3 §6.4c) ───────────────────────────
// Every row carries the evidence columns above. `reproduce` here is the s3 §6.4b one-liner for the row's
// subject (src/oneliners.ts); `reproduceGetLogs` is the exact query for this row's log.

/** The permanent factory's own AccountCreated owner (never the registry's): R-S189-4 AMENDED 2 fallback. */
export const factoryAccounts = onchainTable("factory_accounts", (t) => ({
  id: t.text().primaryKey(), // chainId-account
  ...evidence(t),
  account: t.hex().notNull(),
  owner: t.hex().notNull(),
}));

/** A spend permission (SpendPermissionManager) or a redeemed delegation (DelegationManager). */
export const externalPermissions = onchainTable(
  "external_permissions",
  (t) => ({
    id: t.text().primaryKey(), // chainId-source-permissionId
    ...evidence(t), // first log naming it
    source: t.text().notNull(), // "spm" | "delegation_manager"
    /** SPM: the account. DelegationManager: the delegator of this delegation. */
    subject: t.hex().notNull(),
    /** SPM: the spender. DelegationManager: the delegate (ANY_DELEGATE 0x…0a11 for an open delegation). */
    grantee: t.hex().notNull(),
    /** SPM: the permission hash. DelegationManager: the delegation hash. */
    permissionId: t.hex().notNull(),
    shape: t.text().notNull(), // "a" | "b" | "c" | "d"
    label: t.text().notNull(),
    terms: t.json().notNull(),
    status: t.text().notNull(), // "approved" | "revoked" | "observed-by-use-only"
    useCount: t.integer().notNull(),
  }),
  (t) => ({ bySubject: index().on(t.chainId, t.subject), byGrantee: index().on(t.chainId, t.grantee) }),
);

/** A payment under an external permission: SpendPermissionUsed, or an ERC-20 Transfer from the delegator in a redemption's tx (R-S189-5). */
export const externalPayments = onchainTable(
  "external_payments",
  (t) => ({
    id: t.text().primaryKey(), // chainId-tx-logIndex of the log that moved value
    ...evidence(t),
    source: t.text().notNull(),
    payer: t.hex().notNull(),
    payee: t.hex().notNull(),
    token: t.hex().notNull(),
    amount: t.bigint().notNull(),
    permissionId: t.hex(),
    /** DelegationManager: the redemption log this Transfer sits beside. Null for SPM. */
    redemptionTx: t.hex(),
    redemptionLogIndex: t.integer(),
  }),
  (t) => ({ byPayer: index().on(t.chainId, t.payer), byPayee: index().on(t.chainId, t.payee) }),
);

/** Every RedeemedDelegation. Not a payment (R-S189-5). */
export const externalRedemptions = onchainTable(
  "external_redemptions",
  (t) => ({
    id: t.text().primaryKey(), // chainId-tx-logIndex
    ...evidence(t),
    rootDelegator: t.hex().notNull(),
    redeemer: t.hex().notNull(),
    delegate: t.hex().notNull(),
    delegator: t.hex().notNull(),
    authority: t.hex().notNull(),
    hop: t.text().notNull(), // "root" | "child"
    delegationHash: t.hex().notNull(),
    enforcers: t.json().notNull(),
    shape: t.text().notNull(),
    label: t.text().notNull(),
    hadTransfer: t.boolean().notNull(),
  }),
  (t) => ({ byRoot: index().on(t.chainId, t.rootDelegator), byDelegator: index().on(t.chainId, t.delegator) }),
);

/** Agent Credit Lines Borrowed / Repaid / Defaulted at a configured lender. */
export const creditLineEvents = onchainTable(
  "credit_line_events",
  (t) => ({
    id: t.text().primaryKey(), // chainId-tx-logIndex
    ...evidence(t),
    lender: t.hex().notNull(),
    agentId: t.bigint().notNull(),
    loanId: t.bigint().notNull(),
    kind: t.text().notNull(), // "borrowed" | "repaid" | "defaulted"
    /** Borrowed: to. Repaid: payer. Defaulted: owner. */
    party: t.hex().notNull(),
    principal: t.bigint().notNull(),
    fee: t.bigint(),
    dueAt: t.bigint(),
    label: t.text().notNull(),
  }),
  (t) => ({ byAgent: index().on(t.chainId, t.agentId) }),
);
