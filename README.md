# nablaz-sdk

An open-source reader for agent payment permissions. It rebuilds, from public chain data, what an address
was allowed to spend, what it spent, and under which terms, and keeps every fact next to the command that
reproduces it. It reads the NablaZ record and grantee vaults, Coinbase spend permissions, MetaMask
delegations and Agent Credit Lines.

It holds no keys, needs no account or API key, and runs anywhere you have an RPC endpoint.

## What it reads

Arbitrum One and Base are both enabled. The NablaZ contracts are live on Arbitrum One only, so on Base
the reader indexes the third-party sources alone.

Third-party sources, on both chains:

- Coinbase `SpendPermissionManager`: `SpendPermissionApproved`, `SpendPermissionUsed`,
  `SpendPermissionRevoked`.
- MetaMask `DelegationManager` (delegation framework v1.3.0): `RedeemedDelegation`, with every caveat
  decoded. For each redemption the reader reads the transaction receipt and keeps the ERC-20 `Transfer`s
  sent by the delegator. A redemption alone is not a payment; only such a `Transfer` is.
- Agent Credit Lines (`Borrowed`, `Repaid`, `Defaulted`) at a configured lender. No lender is known on
  either chain today, so none is registered. The decoder ships with tests, and an empty read is reported as
  empty.

NablaZ sources, where deployed:

- `RecordEntry` from `NablaRecord`, every field.
- `AccountCreated` from `NablaAccountFactoryPermanent` and `AccountRegistryV6`, to discover accounts.
- ERC-1967 `Upgraded` on every discovered account proxy.
- USDC `AuthorizationUsed` and `Transfer` where the authorizer or sender is a grantee vault. Vaults are
  discovered from logs alone: the `PAY_AUTHORIZED` entry names the vault, and the funding `Transfer` in the
  same transaction confirms it.

## What it writes

| Table | One row per |
|---|---|
| `record_entries` | `RecordEntry`, raw |
| `obligation_pairs` | `OBLIGATION_OPENED` / `REPAY` / `OBLIGATION_CLOSED` entry, grouped by `obligationRef` |
| `vault_payments` | settlement: a vault's `AuthorizationUsed` paired with its `Transfer`, and the grant and envelope it drew against |
| `implementation_history` | `Upgraded` log or `IMPLEMENTATION_CHANGED` entry, per account |
| `counterparties` | distinct (subject, counterparty) pair, with first evidence and counts |
| `accounts`, `grants`, `vaults`, `vault_fundings` | discovery and pairing state the tables above are built from |
| `factory_accounts` | account created on the permanent factory, with the owner from the factory's own event |
| `external_permissions` | spend permission or redeemed delegation, with its shape, label and decoded terms |
| `external_payments` | `SpendPermissionUsed`, or an ERC-20 `Transfer` from the delegator in a redemption's transaction |
| `external_redemptions` | `RedeemedDelegation`, whether or not it moved value |
| `credit_line_events` | `Borrowed` / `Repaid` / `Defaulted` at a configured lender |

Rows hold facts and counts. The reader passes no judgement on any subject and produces no verdict.

In `vault_payments`, the party that submitted the settlement transaction (`tx.from`) is recorded as
`submitter`. It is never treated as the counterparty; the counterparty is the `Transfer` recipient.

A settlement writes no `NablaRecord` entry. A payment's record is two parts, paired by the reader: the
`PAY_AUTHORIZED` entry the account wrote when it reserved funds into the grantee vault (the reservation,
in `record_entries`), and USDC's own `AuthorizationUsed` and `Transfer` events (the settlement, one
`vault_payments` row). A citation of a payment cites both: the `PAY_AUTHORIZED` log (block, transaction
hash, log index) and the USDC settlement transaction and its block.

## Citation rule

The logs are the ground truth; this reader is a convenience over them. Every row carries the chain id,
block number, transaction hash and log index of its evidence, plus a `cast logs` command and the
equivalent raw `eth_getLogs` request that return that log from any RPC. A row you cannot reproduce from
its command is a bug.

One field is a state read, not a log: the envelope expiry in `vault_payments`. It is labelled
"state read — needs archive RPC". The reader calls `envelopeOf(account, granteeKey, token)` on the
account's mandate at block N−1 and at the settlement block N, and stores both calls as `cast call --block`
commands. If the two reads agree, the value is stored. If they differ, the envelope changed within block
N, and the field is stored as "not determinable" with both reads cited. On 2026-10-23, the same
historical `eth_call` at 50,000 blocks below head answered 6 of 10 times through
`https://arb1.arbitrum.io/rpc`, and the other 4 returned "historical state … is not available", so a
public endpoint cannot be relied on for this field. Everything else rebuilds from logs on any RPC.

## Read

`GET /read/:chainId/:address` returns every indexed fact about an address. No key is needed: the endpoint
is a read over public logs.

```json
{ "subject": "0x…", "chainId": 8453, "asOfBlock": "53160200",
  "facts": [ { "source": "metamask:delegation_payment", "label": "(b) exact execution, once", "shape": "b",
               "terms": { "payer": "0x…", "payee": "0x…", "token": "0x…", "amount": "…" },
               "cite": { "chainId": 8453, "block": "…", "tx": "0x…", "logIndex": 0 },
               "reproduce": "cast receipt 0x… --rpc-url \"$BASE_RPC_URL\" --json | jq …" } ],
  "selfDealing": null, "exposure": null,
  "notes": [ "no Agent Credit Lines lender registered on this chain" ] }
```

- **facts**: one per record entry, vault payment, spend permission, delegation, payment, redemption and
  credit-line event. Each names its source and carries a permission label, the block, transaction and log
  index, and the one-line command that returns the same log from any RPC.
- **selfDealing** (NablaZ accounts only): distinct counterparties paid, share of value paid to accounts
  under the same controller, share paid to counterparties with no record, and the sentence "A payee
  controlled by the same person under another key cannot be detected from chain data."
- **exposure** (NablaZ accounts only): per grant and token, the least remaining allowance across windows
  plus the vault balance, with the limit that outstanding authorizations are not observable onchain.
- **notes**: every source that returned nothing, and every fact that is not determinable, stated as text.

Every permission label has one of five shapes:

| Shape | Label | Where it comes from |
|---|---|---|
| (a) | allowance, per period / total / per call / per execution / streamed | Coinbase spend permissions; MetaMask amount enforcers; NablaZ CAM V4 windows ("within mandate by construction" for a canonical NablaZ account) |
| (b) | exact execution, once / N times / count unbounded | MetaMask exact-call enforcers; the count from `LimitedCallsEnforcer` or a single-use enforcer |
| (c) | not determinable | an enforcer in no vendor list, terms that do not decode, a non-canonical NablaZ account |
| (d) | no limit on amount or call | a delegation whose caveats only restrict the call or the redeemer |
| (e) | third-party attestation, writer named | Agent Credit Lines; record entries another writer placed |

The MetaMask enforcer table is generated from the vendor's `Deployments.md` at a pinned commit
(`scripts/gen-enforcers.ts`, `src/generated/enforcers.json`). A test fails when the vendor's main branch
lists an enforcer the table lacks.

**One-liners are the ground truth.** The reader is a convenience over the logs. Each `reproduce` field is
a `cast` command you can run yourself with an RPC URL in `$ARB_ONE_RPC_URL` or `$BASE_RPC_URL`.

## Running it

Requires Node 22.12+ and pnpm.

```sh
pnpm install
export READER_ARB_RPC_URL=...        # Arbitrum One RPC; archive for the envelope and exposure reads
export READER_BASE_RPC_URL=...       # Base RPC; public endpoints rate-limit eth_getLogs
export PONDER_TELEMETRY_DISABLED=true
cd packages/reader && pnpm start --schema reader
curl localhost:42069/read/8453/0x…
```

Tables land in a local PGlite database under `.ponder/`. RPC URLs are read from the environment only and
are never written to the repository.

The third-party sources start at their deployment blocks, which is years of history. For a read over a
recent window, start them later, per chain:

```sh
export READER_EXTERNAL_FROM=42161:518700000,8453:53150000
```

Facts before that block are then not indexed, and the notes in each read state the range read.
`READER_CHAINS=8453` limits the instance to one chain; `READER_SOURCES=external` (or `nabla`) to one
source group.

## Tests

```sh
pnpm typecheck
pnpm test          # unit
pnpm test:fork     # needs READER_ARB_RPC_URL (archive), READER_BASE_RPC_URL, anvil and cast (Foundry)
```

The fork tests run an anvil fork of Arbitrum One, drive the live contracts from TypeScript using the
ABIs in `abis/`, index the result from scratch, and assert the derived rows. They index twice and require
identical tables. A separate test indexes Arbitrum One up to the block before the first account and
requires every table to come back empty. On both chains, a third test indexes the third-party sources over
a fixed window. It runs one rendered one-liner per source through `cast`, requires the same count as the
reader's rows, and prints the share of sampled redemptions labelled "not determinable".

## Provenance

Contract addresses (`src/generated/addresses.ts`) and ABIs (`abis/*.json`) are generated from a pinned
nablaz-protocol commit; each generated file records the commit in its header. Only addresses and ABIs
come from there: both are public on chain.

## License

MIT. See [LICENSE](LICENSE).
