// GET /read assembly: pure functions from indexed rows and state reads to the response. No I/O; the
// queries and state reads are in src/api/index.ts. Rulings: R-D2B-1 (cite + reproduce on every fact),
// R-D2B-4 (authorization chain per payment), R-D2B-6 (batch-aware counts), R-S189-3 AMENDED 2/3 (labels),
// R-S189-4 AMENDED 2 (controller, self-dealing), R-S189-5 (a redemption is not a payment), R-S189-6
// (nothing indexed is reported as such; R-S190-5/6 wording), s3 §6.4a reader note (exposure).

import { getAddress, type Address, type Hex } from "viem";
import { LABEL, attestationLabel, type NablaLabel } from "./labels.ts";
import { render } from "./oneliners.ts";

/** R-S189-4: the fixed sentence, verbatim (s3 §6.4a). */
export const SELF_DEALING_SENTENCE = "A payee controlled by the same person under another key cannot be detected from chain data.";

/** s3 §6.4a reader note, outstanding authorizations (R-B0-1): a disclosed limit, not a number. */
export const OUTSTANDING_AUTHORIZATIONS =
  "Outstanding authorizations can exist. Each one is bounded by the vault balance and expires at its own validBefore. Unsettled authorizations are not observable onchain.";

export const NOT_DETERMINABLE = "not determinable";

/** R-S190-5: a redemption with no same-transaction Transfer, stated as the fact. */
export const NO_TRANSFER = "no ERC-20 Transfer from the delegator in this tx; not a payment (R-S189-5)";

/** A source's indexed range: from its start block to the block the read is taken at. */
export type IndexedRange = { from: number | null; to: bigint };

/**
 * R-S190-5 / R-S190-6: "nothing indexed (blocks X..Y)" for a source that returned nothing; while the indexer
 * is still below the source's start block, "indexed up to X; source starts at Y". Never a backwards range.
 */
export function rangeNote(text: string, r: IndexedRange): string {
  if (r.from !== null && BigInt(r.from) > r.to) return `${text}: indexed up to ${r.to}; source starts at ${r.from}`;
  return `${text}: nothing indexed (blocks ${r.from ?? "?"}..${r.to})`;
}

type Row = Record<string, any>;

export type Fact = {
  source: string;
  label: string;
  shape: string;
  terms: Record<string, unknown>;
  cite: { chainId: number; block: string; tx: Hex; logIndex: number };
  reproduce: string;
};

const cite = (r: Row) => ({ chainId: r.chainId as number, block: String(r.blockNumber), tx: r.txHash as Hex, logIndex: r.logIndex as number });
const lc = (a: string) => a.toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lc(a) === lc(b);
const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const plain = (r: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, str(r[k])]));

// ── Controller (R-S189-4 AMENDED 2) ─────────────────────────────────

export type ControllerInput = {
  /** CONTROLLER_ROTATED record entries about the account (any writer). */
  rotations: Row[];
  /** The permanent factory's own AccountCreated owner, or null if the account was not created there. */
  factoryOwner: Address | null;
  /** The account's implementation is in the currentAccountImpl lineage. */
  canonicalImpl: boolean;
};

export type Controller = { controller: Address; from: "CONTROLLER_ROTATED" | "AccountCreated"; cite?: ReturnType<typeof cite> } | { controller: null; reason: string };

/** controller(account) at `block`: the latest self-written CONTROLLER_ROTATED, else the factory's owner. */
export function controllerAt(account: Address, block: bigint, x: ControllerInput): Controller {
  if (!x.canonicalImpl) return { controller: null, reason: `${NOT_DETERMINABLE}: implementation is not in the currentAccountImpl lineage` };
  const own = x.rotations
    .filter((r) => same(r.subject, account) && same(r.writer, account) && BigInt(r.blockNumber) <= block)
    .sort((a, b) => (BigInt(a.blockNumber) === BigInt(b.blockNumber) ? a.logIndex - b.logIndex : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1));
  const last = own.at(-1);
  if (last) return { controller: getAddress(last.counterparty), from: "CONTROLLER_ROTATED", cite: cite(last) };
  if (x.factoryOwner) return { controller: getAddress(x.factoryOwner), from: "AccountCreated" };
  return { controller: null, reason: `${NOT_DETERMINABLE}: no AccountCreated from the permanent factory` };
}

// ── Self-dealing (R-D2B-3 as superseded by R-S189-4) ────────────────

export type Payment = { payee: Address; token: Address; value: bigint; block: bigint; cite: ReturnType<typeof cite> };

export type SelfDealingInput = {
  subject: Address;
  subjectController: ControllerInput;
  payments: Payment[];
  /** Per payee that is a NablaZ account on this chain: its controller input. */
  payeeControllers: Map<string, ControllerInput>;
  /** Payees that are the subject of at least one record entry. */
  payeesWithRecord: Set<string>;
};

export function selfDealing(x: SelfDealingInput) {
  const notes: string[] = [];
  const settlements = x.payments.length;
  const distinct = new Set(x.payments.map((p) => lc(p.payee))).size;
  if (!x.subjectController.canonicalImpl) {
    return {
      result: {
        distinctCounterparties: distinct,
        settlements,
        controller: NOT_DETERMINABLE,
        shareToSameController: null,
        shareToCounterpartiesWithoutRecord: null,
        sentence: SELF_DEALING_SENTENCE,
      },
      notes: [`controller history: ${NOT_DETERMINABLE} (implementation is not in the currentAccountImpl lineage); shares omitted`],
    };
  }
  // Shares are per token: values in different tokens are never summed.
  const byToken = new Map<string, { total: bigint; same: bigint; noRecord: bigint; undetermined: bigint }>();
  for (const p of x.payments) {
    const t = byToken.get(lc(p.token)) ?? { total: 0n, same: 0n, noRecord: 0n, undetermined: 0n };
    t.total += p.value;
    if (!x.payeesWithRecord.has(lc(p.payee))) t.noRecord += p.value;
    const payeeIn = x.payeeControllers.get(lc(p.payee));
    if (payeeIn) {
      const mine = controllerAt(x.subject, p.block, x.subjectController);
      const theirs = controllerAt(p.payee, p.block, payeeIn);
      if (mine.controller === null || theirs.controller === null) t.undetermined += p.value;
      else if (same(mine.controller, theirs.controller)) t.same += p.value;
    }
    byToken.set(lc(p.token), t);
  }
  const share = (n: bigint, d: bigint) => ({ value: n.toString(), total: d.toString(), share: d === 0n ? null : Number((n * 1_000_000n) / d) / 1_000_000 });
  const shareToSameController: Record<string, unknown> = {};
  const shareToCounterpartiesWithoutRecord: Record<string, unknown> = {};
  for (const [token, t] of byToken) {
    shareToSameController[token] = { ...share(t.same, t.total), ...(t.undetermined > 0n ? { notDeterminableValue: t.undetermined.toString() } : {}) };
    shareToCounterpartiesWithoutRecord[token] = share(t.noRecord, t.total);
    if (t.undetermined > 0n) notes.push(`same-controller share for ${token}: ${t.undetermined} paid to NablaZ accounts whose controller is ${NOT_DETERMINABLE}`);
  }
  if (settlements === 0) notes.push("no settled payment from this account in the indexed range");
  const c = controllerAt(x.subject, BigInt(Number.MAX_SAFE_INTEGER), x.subjectController);
  return {
    result: {
      distinctCounterparties: distinct,
      settlements,
      controller: c.controller ?? NOT_DETERMINABLE,
      shareToSameController,
      shareToCounterpartiesWithoutRecord,
      sentence: SELF_DEALING_SENTENCE,
    },
    notes,
  };
}

// ── Exposure (s3 §6.4a reader note) ─────────────────────────────────

export type ExposureGrant = {
  grantId: Hex;
  token: Address;
  /** grantOf(account, grantId).allowances[i].remaining for this token, one per window. */
  remaining: bigint[];
  vault: Address | null;
  vaultBalance: bigint | null;
};

export function exposure(canonicalMandate: boolean, grants: ExposureGrant[], asOfBlock: bigint) {
  if (!canonicalMandate)
    return {
      result: { computable: false, reason: `${NOT_DETERMINABLE}: dependencies().mandate is not CAM V4 by code hash`, outstandingAuthorizations: OUTSTANDING_AUTHORIZATIONS },
      notes: [`exposure: ${NOT_DETERMINABLE} (mandate is not CAM V4 by code hash)`],
    };
  const rows = grants.map((g) => {
    const window = g.remaining.length === 0 ? null : g.remaining.reduce((m, x) => (x < m ? x : m));
    return {
      grantId: g.grantId,
      token: g.token,
      minRemainingOverWindows: window?.toString() ?? null,
      vault: g.vault,
      vaultBalance: g.vaultBalance?.toString() ?? null,
      exposure: window === null ? null : (window + (g.vaultBalance ?? 0n)).toString(),
    };
  });
  return {
    result: { computable: true, asOfBlock: asOfBlock.toString(), grants: rows, outstandingAuthorizations: OUTSTANDING_AUTHORIZATIONS },
    notes: grants.length === 0 ? ["exposure: no GRANT_SET for this account in the indexed range"] : [],
  };
}

// ── Facts ───────────────────────────────────────────────────────────

/** Record entries: the account's own entries carry its NablaZ label; entries another writer placed are that writer's attestation. */
export function recordFacts(rows: Row[], nabla: NablaLabel | null): Fact[] {
  return rows.map((r) => {
    const own = same(r.writer, r.subject) && nabla !== null;
    return {
      source: "nablaz:record",
      label: own ? nabla!.label : attestationLabel(r.writer),
      shape: own ? nabla!.shape : "e",
      terms: plain(r, ["kindName", "kind", "writer", "writerAuth", "counterparty", "counterpartyAuth", "policyHash", "policyVersion", "asset", "amount", "obligationRef", "seq"]),
      cite: cite(r),
      reproduce: render("1-record-entries", { chainId: r.chainId, subject: r.subject }),
    };
  });
}

/** Vault payment pairs (R-S187-1) with the authorization chain (R-D2B-4). */
export function vaultPaymentFacts(rows: Row[], nabla: NablaLabel | null): Fact[] {
  return rows.map((r) => ({
    source: "nablaz:vault_payment",
    label: nabla?.label ?? LABEL.c,
    shape: nabla?.shape ?? "c",
    terms: {
      ...plain(r, ["vault", "payee", "value", "token", "nonce", "submitter", "transferLogIndex"]),
      authorization: plain(r, ["grantIdFromLogs", "fundingEntryId", "policyHash", "policyVersion", "envelopeStatus", "envelopeGrantId", "envelopeExpiry", "grantMatchesEnvelope"]),
      counts: { settlements: r.settlements, settlementOrdinalInTx: r.settlementOrdinalInTx, settlementsInTx: r.settlementsInTx, calls: str(r.calls), callsStatus: r.callsStatus },
    },
    cite: cite(r),
    reproduce: `${render("2-authorization-used", { chainId: r.chainId, vault: r.vault })}\n${render("2-vault-transfer", { chainId: r.chainId, vault: r.vault, tx: r.txHash })}`,
  }));
}

export function permissionFacts(rows: Row[]): Fact[] {
  return rows.map((r) => ({
    source: r.source === "spm" ? "coinbase:spend_permission" : "metamask:delegation",
    label: r.label,
    shape: r.shape,
    terms: { subject: r.subject, grantee: r.grantee, permissionId: r.permissionId, status: r.status, useCount: r.useCount, ...(r.terms as object) },
    cite: cite(r),
    reproduce: r.reproduce,
  }));
}

/** A payment's label is its permission's label. */
export function paymentFacts(rows: Row[], permissions: Map<string, Row>): Fact[] {
  return rows.map((r) => {
    const p = r.permissionId ? permissions.get(`${r.chainId}-${r.source === "spm" ? "spm" : "dm"}-${lc(r.permissionId)}`) : undefined;
    return {
      source: r.source === "spm" ? "coinbase:spend_permission_payment" : "metamask:delegation_payment",
      label: p?.label ?? LABEL.c,
      shape: p?.shape ?? "c",
      terms: {
        ...plain(r, ["payer", "payee", "token", "amount", "permissionId", "redemptionTx", "redemptionLogIndex"]),
        ...(p ? {} : { permission: `${NOT_DETERMINABLE}: permission row not indexed` }),
      },
      cite: cite(r),
      reproduce: r.reproduce,
    };
  });
}

/** The enforcers (nested groups included) that are in no vendor list the table is built from. */
export function unknownEnforcerReason(enforcers: unknown): string {
  const out: string[] = [];
  const walk = (cs: any[]) => {
    for (const c of cs ?? []) {
      if (c.name === null) out.push(c.enforcer);
      else if (c.class === null) out.push(`${c.name} (terms do not decode)`);
      for (const g of c.groups ?? []) walk(g);
    }
  };
  walk(enforcers as any[]);
  return out.length ? `enforcer not in the table: ${out.join(", ")}` : "a caveat group is not determinable";
}

export function redemptionFacts(rows: Row[]): Fact[] {
  return rows.map((r) => ({
    source: "metamask:redemption",
    label: r.label,
    shape: r.shape,
    terms: {
      ...plain(r, ["rootDelegator", "redeemer", "delegate", "delegator", "authority", "hop", "delegationHash", "hadTransfer"]),
      enforcers: r.enforcers,
      ...(r.shape === "c" ? { reason: unknownEnforcerReason(r.enforcers) } : {}),
      payment: r.hadTransfer ? "see the delegation_payment facts in this tx" : NO_TRANSFER,
    },
    cite: cite(r),
    reproduce: r.reproduce,
  }));
}

export function creditLineFacts(rows: Row[]): Fact[] {
  return rows.map((r) => ({
    source: "agent_credit_lines",
    label: r.label,
    shape: "e",
    terms: plain(r, ["lender", "agentId", "loanId", "kind", "party", "principal", "fee", "dueAt"]),
    cite: cite(r),
    reproduce: r.reproduce,
  }));
}

/** R-S189-6 / R-S190-5: one note per source that returned nothing, never omitted. */
export function emptySourceNotes(x: {
  chainId: number;
  hasNabla: boolean;
  /** Source groups this instance indexes (READER_SOURCES). */
  indexed: Set<"nabla" | "external">;
  lenders: number;
  counts: Record<string, number>;
  ranges: Record<string, IndexedRange>;
}): string[] {
  const notes: string[] = [];
  const say = (key: string, text: string) => {
    if ((x.counts[key] ?? 0) === 0) notes.push(rangeNote(text, x.ranges[key] ?? { from: null, to: 0n }));
  };
  if (!x.hasNabla) notes.push(`no NablaZ source on chain ${x.chainId} (R-S189-1)`);
  else if (!x.indexed.has("nabla")) notes.push("NablaZ sources: not indexed by this instance (READER_SOURCES), so no NablaZ fact is reported");
  else {
    say("record", "NablaRecord entries about this address");
    say("vault_payment", "vault payments from this address");
  }
  if (!x.indexed.has("external")) {
    notes.push(
      "third-party sources: not indexed by this instance (READER_SOURCES), so no SpendPermissionManager, DelegationManager, Agent Credit Lines or ERC-8004 fact is reported",
    );
    return notes;
  }
  say("spm", "SpendPermissionManager permissions and spends for this address");
  say("dm", "DelegationManager redemptions naming this address");
  if (x.lenders === 0) notes.push("no Agent Credit Lines lender registered on this chain");
  else say("credit", "Agent Credit Lines events naming this address");
  say("agent_wallet", "ERC-8004 agentIds whose agentWallet or owner this address has been");
  if ((x.counts.agent_wallet ?? 0) > 0) say("feedback", "ERC-8004 feedback about those agentIds");
  return notes;
}

/** Every (c) label among the facts, stated as a note. */
export function notDeterminableNotes(facts: Fact[]): string[] {
  const out: string[] = [];
  for (const f of facts) {
    if (f.shape !== "c") continue;
    const reason = (f.terms as Row).reason ?? (f.terms as Row).permission ?? "";
    out.push(`${f.source} at block ${f.cite.block} tx ${f.cite.tx} log ${f.cite.logIndex}: ${LABEL.c}${reason ? ` (${reason})` : ""}`);
  }
  return out;
}

// ── Feedback grounding (R-D2B-2; AFG definition; R-S191-11, R-S191-12) ──

export const GROUNDING_SOURCE = "erc8004:feedback_grounding";
/** The off-chain fields are not fetched (R-S191-13). */
export const FEEDBACK_URI_NOT_READ = "feedbackURI not read: proofOfPayment and the feedback file are off chain and are not fetched";
/** R-S191-11: the label of a grounding transfer that no permission object covers. */
export const DIRECT_TRANSFER = "direct transfer, no permission object";
export const PLAIN_TRANSFER_SOURCE = "erc20:transfer";

/** Payment facts this reader produces from its sources; a grounding transfer that is one keeps its label. */
export const PAYMENT_SOURCES = ["nablaz:vault_payment", "coinbase:spend_permission_payment", "metamask:delegation_payment"] as const;

/**
 * An ERC-20 Transfer from the rater: a Transfer log with topic1 = the rater, any token. A vault settlement
 * from one of the rater's own grantee vaults counts as from the rater (the reader's payer for a vault
 * payment is the account, src/read.ts vaultPaymentFacts).
 */
export type RaterTransfer = { chainId: number; token: Address; from: Address; to: Address; amount: bigint; block: bigint; tx: Hex; logIndex: number };

/** A labelled payment fact, matched to a Transfer by transaction and the Transfer's log index. */
export type LabelledPayment = { fact: Fact; tx: Hex; transferLogIndex: number };

/**
 * R-S191-16: the payment address of an agentId at a block: getAgentWallet there, else ownerOf there. "none" when the
 * identity did not exist at that block (ownerOf reverts). Always resolved at the payment's own block.
 */
export type Binding = { kind: "agentWallet" | "owner"; address: Address } | { kind: "none" };
export const BINDING_TEXT = { agentWallet: "agentWallet", owner: "owner, no agentWallet" } as const;
/** R-S191-18: native-token transfers are not read for grounding. */
export const NATIVE_NOT_READ = "native-token transfers not read";
export const IDENTITY_DID_NOT_EXIST = "identity did not exist at the payment block";

/** A grounding transfer: rater → the address bound at the transfer's block (R-S191-16), with its label. */
export type GroundingPayment = { fact: Fact; payer: Address; payee: Address; block: bigint; logIndex: number; binding: "agentWallet" | "owner" };

/**
 * R-S191-11 / R-S191-16: the rater's transfers whose recipient is the address bound at the transfer's own block.
 * `bindingAt(block)` is the binding at exactly that block (undefined when no binding was read for it: the
 * recipient was not a candidate). Each keeps its permission label when it is one of the reader's payment facts;
 * otherwise it is (c), "direct transfer, no permission object". The label never decides whether a transfer
 * grounds. `preIdentity` lists candidate transfers made while the identity did not exist.
 */
export function groundingTransfers(
  transfers: RaterTransfer[],
  bindingAt: (block: bigint) => Binding | undefined,
  labelled: LabelledPayment[],
): { payments: GroundingPayment[]; preIdentity: RaterTransfer[] } {
  const byLog = new Map(labelled.map((l) => [`${lc(l.tx)}-${l.transferLogIndex}`, l.fact]));
  const payments: GroundingPayment[] = [];
  const preIdentity: RaterTransfer[] = [];
  for (const t of transfers) {
    const b = bindingAt(t.block);
    if (!b) continue;
    if (b.kind === "none") {
      preIdentity.push(t);
      continue;
    }
    if (!same(t.to, b.address)) continue;
    payments.push({
      fact:
        byLog.get(`${lc(t.tx)}-${t.logIndex}`) ?? {
          source: PLAIN_TRANSFER_SOURCE,
          label: LABEL.c,
          shape: "c",
          terms: { payer: getAddress(t.from), payee: getAddress(t.to), token: getAddress(t.token), amount: t.amount.toString(), reason: DIRECT_TRANSFER },
          cite: { chainId: t.chainId, block: t.block.toString(), tx: t.tx, logIndex: t.logIndex },
          // s3 §6.4b (5)'s receipt line: the Transfers sent by an address in one transaction.
          reproduce: render("5-delegator-transfer", { chainId: t.chainId, tx: t.tx, rootDelegator: t.from }),
        },
      payer: getAddress(t.from),
      payee: getAddress(t.to),
      block: t.block,
      logIndex: t.logIndex,
      binding: b.kind,
    });
  }
  return { payments, preIdentity };
}

export type GroundingInput = {
  subject: Address;
  /** A feedbacks row. */
  feedback: Row;
  /** groundingTransfers' result, or the read that could not be made. */
  payments: { payments: GroundingPayment[]; preIdentity: RaterTransfer[] } | { error: string };
  /** The block range the rater's transfers were read over (it ends at the feedback block). */
  transfersRange: { from: number; to: bigint };
  /** R-S191-12/16: getAgentWallet at the feedback block (null: cleared or never set). Reported, never the test. */
  walletAtFeedback: Address | null | { error: string };
  /** The rater's and the subject's controller, when each is a NablaZ account on this chain; else null. */
  raterController: Controller | null;
  subjectController: Controller | null;
};

const before = (p: { block: bigint; logIndex: number }, block: bigint, logIndex: number) => p.block < block || (p.block === block && p.logIndex < logIndex);

/**
 * One grounding fact per feedback: grounded when an ERC-20 Transfer from the rater to the address bound at the
 * transfer's block (agentWallet, else owner; R-S191-16) settled before the feedback, by block and then by log
 * index within the block. The
 * fact is the rater's attestation (e), writer named. Never the feedback's value, decimals, tags or URIs.
 */
export function groundingFact(x: GroundingInput): Fact {
  const f = x.feedback;
  const block = BigInt(f.blockNumber);
  const client = getAddress(f.client);
  const range = `blocks ${x.transfersRange.from}..${x.transfersRange.to}`;
  let status: "grounded" | "not grounded" | "not determinable";
  let reason: string | undefined;
  let payment: GroundingPayment | undefined;
  if (BigInt(x.transfersRange.from) > block) {
    status = "not determinable";
    reason = `transfers indexed up to ${x.transfersRange.to}; source starts at ${x.transfersRange.from}`;
  } else if ("error" in x.payments) {
    status = "not determinable";
    reason = `the rater's transfers in ${range} could not be read (${x.payments.error})`;
  } else {
    const mine = x.payments.payments.filter((p) => same(p.payer, client));
    const preIdentity = x.payments.preIdentity.some((t) => same(t.from, client) && before(t, block, f.logIndex));
    const sameBlockUnordered = mine.some((p) => p.block === block && !Number.isInteger(p.logIndex));
    payment = mine
      .filter((p) => before(p, block, f.logIndex))
      .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1))
      .at(-1);
    if (payment) status = "grounded";
    else if (sameBlockUnordered) {
      status = "not determinable";
      reason = "same block";
    } else if (preIdentity) {
      status = "not grounded";
      reason = IDENTITY_DID_NOT_EXIST;
    } else {
      status = "not grounded";
      reason = `no ERC-20 Transfer from the rater to the address bound at its block (agentWallet, else owner), before the feedback (${range})`;
    }
  }
  const walletAtFeedback =
    x.walletAtFeedback === null
      ? "wallet at feedback: cleared"
      : typeof x.walletAtFeedback === "object"
        ? `wallet at feedback: ${NOT_DETERMINABLE} (${x.walletAtFeedback.error})`
        : `wallet at feedback: ${getAddress(x.walletAtFeedback)}`;
  const sameController = (() => {
    if (!x.raterController || !x.subjectController) return `${NOT_DETERMINABLE}: the rater and the subject are not both NablaZ accounts on this chain`;
    if (x.raterController.controller === null || x.subjectController.controller === null) return `${NOT_DETERMINABLE}: a controller is not determinable`;
    return same(x.raterController.controller, x.subjectController.controller);
  })();
  return {
    source: GROUNDING_SOURCE,
    label: attestationLabel(client),
    shape: "e",
    terms: {
      agentId: str(f.agentId),
      rater: client,
      feedbackIndex: str(f.feedbackIndex),
      grounding: status,
      ...(reason ? { reason } : {}),
      ...(payment ? { payment: { ...payment.fact, payer: payment.payer, boundAtPayment: payment.payee }, binding: BINDING_TEXT[payment.binding] } : {}),
      transfersRead: range,
      nativeTransfers: "not read",
      walletAtFeedback,
      raterIsSubject: same(client, x.subject),
      sameController,
      feedbackURI: "not read",
    },
    cite: cite(f),
    reproduce: f.reproduce,
  };
}

// ── (c) share (R-S190-3) ─────────────────────────────────────────────

export type CShare = Record<string, { count: { c: number; total: number }; value: { c: string; total: string } }>;

/** Per token, over the payment facts given: count and value labelled (c), over all. Never summed across tokens. */
export function cShare(facts: Fact[]): CShare {
  const out: Record<string, { count: { c: number; total: number }; value: { c: bigint; total: bigint } }> = {};
  for (const f of facts) {
    if (!(PAYMENT_SOURCES as readonly string[]).includes(f.source)) continue;
    const t = f.terms as Row;
    const token = getAddress(String(t.token));
    const v = BigInt(String(t.value ?? t.amount ?? 0));
    const e = (out[token] ??= { count: { c: 0, total: 0 }, value: { c: 0n, total: 0n } });
    e.count.total++;
    e.value.total += v;
    if (f.shape === "c") {
      e.count.c++;
      e.value.c += v;
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, e]) => [k, { count: e.count, value: { c: e.value.c.toString(), total: e.value.total.toString() } }]));
}
