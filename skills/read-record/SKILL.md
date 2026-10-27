---
name: read-record
description: Read what an address was allowed to spend, what it spent and under which terms, from the NablaZ reader's GET /read, through the `read_subject` MCP tool or over HTTP. Use when asked what permissions, payments, redemptions or record entries are indexed for an address on Arbitrum One or Base, and to cite each one.
---

# Read the record

The reader rebuilds, from public logs, the permission and payment facts about one address on one chain.
`GET /read/:chainId/:address` returns them (`packages/reader/src/api/index.ts`). Every fact names its
source, carries a permission label, and cites the block, transaction and log index of its evidence with a
command that returns the same log from any RPC (`packages/reader/src/read.ts`, `Fact`). The reader holds no
key and writes nothing. The MCP server has one tool, and it only reads (`packages/mcp/src/server.ts`).

Use the facts as evidence and state them with their source and label. Do not turn them into a judgement
of the address.

## When to use it

- Someone asks what an address may spend or has spent through Coinbase spend permissions, MetaMask
  delegations, a NablaZ account and its grantee vaults, or Agent Credit Lines.
- Someone needs a citation for a payment or a permission: block, transaction hash, log index, and a
  command to reproduce it.

Chains: Arbitrum One (42161) and Base (8453). The NablaZ contracts exist on Arbitrum One only. On Base the
reader indexes only the third-party sources (`packages/reader/src/chains.ts`, R-S189-1). Any other chain
id returns HTTP 404 with `{"error":"chain <id> is not read here"}`.

## How to call it

Start the reader and the MCP server locally (README, "Running it"). The MCP server reads
`NABLAZ_READER_URL` or `--reader-url`, and uses `http://localhost:42069` when neither is set.

MCP tool `read_subject`, arguments `{ "chainId": 42161, "address": "0x…" }`. The result has two text
parts:

1. `chain <chainId>, as of block <asOfBlock>`;
2. the `GET /read` body, byte for byte.

If the API answers with a non-2xx status, the result is an error with two parts:
`GET /read/<chainId>/<address>: HTTP <status>`, then the API's body unchanged. If the reader does not
answer at all, the result is an error starting `the reader at <url> did not answer`. That is a failed
read. It says nothing about the address.

Over HTTP, without MCP:

```sh
curl localhost:42069/read/42161/0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c
```

The response (`packages/reader/src/api/index.ts`):

| Field | What it is |
|---|---|
| `subject`, `chainId` | the address (checksummed) and chain |
| `asOfBlock` | the indexed block the read is taken at. State reads also use this block, never the chain head |
| `facts` | one per indexed row about the address, ordered by block and log index |
| `selfDealing` | NablaZ accounts only, otherwise `null` |
| `exposure` | NablaZ accounts only, otherwise `null` |
| `cShare` | per token: how many of this read's payment facts, and how much of their value, are labelled (c), over all of them; never summed across tokens (R-S190-3) |
| `notes` | every source with nothing indexed, and every fact that is not determinable, written as text |

## Reading a fact

Each fact has `source`, `label`, `shape`, `terms`, `cite` (`chainId`, `block`, `tx`, `logIndex`) and
`reproduce` (`packages/reader/src/read.ts`). The `source` values:

| `source` | Row | Label it carries |
|---|---|---|
| `nablaz:record` | a `RecordEntry` about the address | the account's NablaZ label if the account wrote it; otherwise (e), naming the writer |
| `nablaz:vault_payment` | a grantee-vault settlement: USDC `AuthorizationUsed` paired with its `Transfer` | the account's NablaZ label, or (c) when the account has no NablaZ label |
| `coinbase:spend_permission` | a `SpendPermissionApproved` (status and use count included) | `(a) allowance, per period` |
| `coinbase:spend_permission_payment` | a `SpendPermissionUsed` | its permission's label |
| `metamask:delegation` | a redeemed delegation, with every caveat decoded | its shape from the caveats |
| `metamask:delegation_payment` | an ERC-20 `Transfer` from the delegator in a redemption's transaction | its delegation's label, or (c) if that delegation row is not indexed |
| `metamask:redemption` | a `RedeemedDelegation`, whether or not it moved value | its shape from the caveats |
| `agent_credit_lines` | `Borrowed`, `Repaid` or `Defaulted` at a registered lender | (e), naming the lender |
| `erc8004:feedback_grounding` | an ERC-8004 `NewFeedback` about an agentId whose agentWallet or owner the subject has been, with its grounding | (e), naming the rater |

To cite a fact, give `cite` and `reproduce`. `reproduce` is a `cast` command. It reads the RPC URL from
`$ARB_ONE_RPC_URL` or `$BASE_RPC_URL` (README, "Citation rule"). A vault payment's citation has two parts:
the account's `PAY_AUTHORIZED` entry, where it reserved funds into the vault, and the USDC settlement
transaction. A settlement writes no `NablaRecord` entry (README, "What it writes").

In a vault payment, `terms.submitter` is the address that sent the settlement transaction. It is not the
counterparty. The counterparty is `terms.payee`, the `Transfer` recipient (README).

## The five label shapes

Every label has one of five shapes (`packages/reader/src/labels.ts`, `LABEL`; R-S189-3 AMENDED 3):

- **(a) allowance.** The amount is bounded. The label lists how: per period, total, per call, per
  execution or streamed, for example `(a) allowance, per period`. A NablaZ account whose implementation is
  canonical and whose mandate is CAM V4 carries `(a) within mandate by construction`.
- **(b) exact execution once / N times / count unbounded.** The call is fixed. The count comes from
  `LimitedCallsEnforcer` or from a single-use enforcer: `(b) exact execution, once`,
  `(b) exact execution, 3 times`, or `(b) exact execution, count unbounded` when nothing bounds the count.
  A set whose only exact-call enforcer is `ApprovalRevocationEnforcer` reads
  `(b) exact execution: approval revocation, no value` (R-S189-7).
- **(c) not determinable.** The reader cannot state the bound: an enforcer in no vendor list, terms that
  do not decode, or a NablaZ account whose implementation is not canonical or whose mandate code hash is
  not CAM V4's. `notes` gives the reason for each such fact.
- **(d) no limit on amount or call.** The caveats restrict only the call target or the redeemer, so they
  limit neither the amount nor the call.
- **(e) third-party attestation, writer named.** Another party wrote the fact, and the label ends with that
  writer's address: a record entry the subject did not write, or an Agent Credit Lines event.

A delegation with a `LogicalOrWrapperEnforcer` takes the weakest group the redeemer can pick: (d) if any
group is (d), otherwise (c) if any group is (c), otherwise `any of {…}`, with every group listed in
`anyOf` (`labels.ts`, `weakest`).

A NablaZ account is canonical when its `Upgraded` events name only implementations in the
`currentAccountImpl` lineage, {NablaAccountV3, NablaAccountV3_1}, after at most one first `Upgraded` to
the bootstrap (R-S189-4 AMENDED 2). The lineage is
`packages/reader/src/generated/account-lineage.json`, copied from nablaz-protocol
`script/expected/permanent-arbitrum.txt` at d6aaba99. Any other implementation makes the account's
label `(c) not determinable`.

## Rules

**A redemption is not a payment (R-S189-5).** A `metamask:redemption` fact records that a delegation was
redeemed. Value moved only if a `metamask:delegation_payment` fact exists for the same transaction: an
ERC-20 `Transfer` sent by the delegator. The redemption's `terms.hadTransfer` and `terms.payment` say
which applies. A `coinbase:spend_permission_payment` is a payment by its own event. Name a payer by its
address and its source only. Never call the payer an agent: a fact shows which address signed, redeemed
or paid, never what kind of party is behind it.

**Nothing indexed is not absence (R-S189-6, R-S190-5, R-S190-6).** A note such as
`DelegationManager redemptions naming this address: nothing indexed (blocks 518780000..518782876)` means
nothing indexed for that source in that block range. It does not mean nothing happened on chain. Facts
before the range's first block are not indexed: an instance can start the third-party sources late
(`READER_EXTERNAL_FROM`, README). While the indexer is still below a source's start block, the note reads
`indexed up to <asOfBlock>; source starts at <block>`. A note that a source is `not indexed by this
instance` means this instance does not read that source at all. `no Agent Credit Lines lender registered on
this chain` means no lender is configured (`packages/reader/src/read.ts`, `rangeNote`, `emptySourceNotes`).
Say "nothing indexed" and give the range. A redemption with no same-transaction Transfer says so:
`terms.payment` reads `no ERC-20 Transfer from the delegator in this tx; not a payment (R-S189-5)`.

**Feedback grounding (R-D2B-2, R-S191-11, R-S191-16).** When the subject has been the agentWallet or the
owner of an ERC-8004 agentId, every `NewFeedback` about that agentId becomes an `erc8004:feedback_grounding`
fact, cited at the feedback log (`packages/reader/src/read.ts`, `groundingFact`). The ERC-8004
"Reputation Registry" emits the feedback; the Identity Registry holds the agentWallet and the owner.
`terms.grounding` is one of:

- `grounded`: an ERC-20 Transfer from the rater to the identity's payment address settled before the
  feedback, by block and then by log index within the block. Any token and any route count. The payment
  address is resolved at the transfer's own block, never later: the agentWallet there, else the owner there.
  `terms.binding` says which: `agentWallet` or `owner, no agentWallet`. `terms.payment` is the most recent
  such transfer: it keeps its permission label when it is one of the reader's payment facts, and is
  `(c) not determinable` with reason `direct transfer, no permission object` otherwise. The label says how
  the payment was bounded; it does not decide whether it grounds.
- `not grounded`: no such transfer in the range `terms.transfersRead` states. When the rater's transfer
  to an address later bound to the identity was made before the identity existed, the reason is
  `identity did not exist at the payment block`.
- `not determinable`: only for reads the reader cannot make: the rater's transfers could not be read, or the
  range starts after the feedback ("indexed up to X; source starts at Y").

A settlement from the rater's own grantee vault is a payment from the rater (R-S191-17).
Native-token transfers are not read for grounding: `terms.nativeTransfers` is `not read`, and the notes say
`native-token transfers not read` (R-S191-18).

`terms.walletAtFeedback` reports the agentWallet at the feedback block beside the grounding, as
`wallet at feedback: <address>` or `wallet at feedback: cleared`. It is never the grounding test: the
registry clears the agentWallet when the identity is transferred. The rater's transfers are read with
`eth_getLogs` (topic1 = the rater, any token) from the Identity Registry's start block, or the instance's
start, to the feedback block (`packages/reader/src/grounding-rpc.ts`).

`terms.raterIsSubject` says whether the rater is the subject. `terms.sameController` compares the rater's
and the subject's controllers when both are NablaZ accounts on the chain, and is not determinable
otherwise (R-S189-4). The fact never carries the feedback's value, decimals, tags, endpoint or URIs.
`terms.feedbackURI` is `not read`: the feedback file and its proofOfPayment are off chain and are not
fetched (R-S191-13).

**State reads are labelled.** The envelope expiry in a vault payment is a state read at the settlement
block and the block before it, not a log. If the two reads differ, the field is stored as not
determinable with both reads cited (README, "Citation rule").

**Self-dealing and exposure are counts, with their limits.** `selfDealing` gives distinct counterparties,
the share of value paid to accounts under the same controller and the share paid to counterparties with
no record, per token. It always carries the sentence "A payee controlled by the same person under another
key cannot be detected from chain data." `exposure` gives, per grant and token, the least remaining
allowance across windows, plus the vault balance. It always carries the limit that unsettled
authorizations are not observable onchain (`packages/reader/src/read.ts`).

## What the reader never says

The reader states facts and passes no judgement on any subject (README, "What it writes"). When you
relay a read:

<!-- banned:start -->
- no score, verdict or ranking of an address;
- no "trust", "reputation" or "credit bureau" wording;
<!-- banned:end -->
- no label beyond the five shapes, and no shape inferred where the reader wrote (c);
- never "an agent" for a payer;
- never a claim that nothing happened, only "nothing indexed" in the stated range;
- never a conclusion that two payees are or are not the same person: chain data cannot show it.
