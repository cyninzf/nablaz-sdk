# nablaz-sdk

An open-source indexer for the NablaZ record. It rebuilds, from public chain data, what NablaZ accounts
wrote to the record and what their grantee vaults settled, and keeps every fact next to the command that
reproduces it.

It holds no keys, needs no NablaZ account or API key, and runs anywhere you have an RPC endpoint.

## What it reads

On each enabled chain (Arbitrum One today; Base is configured but disabled):

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

## Running it

Requires Node 22.12+ and pnpm.

```sh
pnpm install
export READER_ARB_RPC_URL=...        # your Arbitrum One RPC; archive for the envelope field
export PONDER_TELEMETRY_DISABLED=true
pnpm start --schema reader
```

Tables land in a local PGlite database under `.ponder/`. The RPC URL is read from the environment only
and is never written to the repository.

## Tests

```sh
pnpm typecheck
pnpm test          # unit
pnpm test:fork     # needs READER_ARB_RPC_URL (archive) and anvil (Foundry)
```

The fork tests run an anvil fork of Arbitrum One, drive the live contracts from TypeScript using the
ABIs in `abis/`, index the result from scratch, and assert the derived rows. They index twice and require
identical tables. A separate test indexes the live chain and requires every table to come back empty
while no accounts exist.

## Provenance

Contract addresses (`src/generated/addresses.ts`) and ABIs (`abis/*.json`) are generated from a pinned
nablaz-protocol commit; each generated file records the commit in its header. Only addresses and ABIs
come from there: both are public on chain.

## License

MIT. See [LICENSE](LICENSE).
