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
  either chain today, so no lender is registered. The decoder ships with tests, and a read with nothing
  indexed says "nothing indexed" with its block range.
- ERC-8004: `NewFeedback` from the "Reputation Registry" (who rated which agentId, and where; never the
  feedback's value, decimals, tags, endpoint or URIs), and the agentWallet and owner histories from the
  Identity Registry's `MetadataSet` and ERC-721 `Transfer`. Addresses from `src/generated/erc8004.json` (vendor commit pinned there).

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
| `feedbacks` | ERC-8004 `NewFeedback`: agentId, rater, feedback index; no value, tags or URIs |
| `agent_wallets` | ERC-8004 `MetadataSet` for the agentWallet key: agentId and wallet (null when cleared) |
| `agent_owners` | ERC-8004 identity `Transfer` (ERC-721): agentId and new owner |

Rows hold facts and counts. The reader states facts and passes no judgement on any subject.

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
  "cShare": { "chainId": 8453, "asOfBlock": "53160200",
              "byToken": { "0x…": { "count": { "c": 0, "total": 1 }, "value": { "c": "0", "total": "…" } } } },
  "notes": [ "no Agent Credit Lines lender registered on this chain",
             "SpendPermissionManager permissions and spends for this address: nothing indexed (blocks 53160000..53160200)" ] }
```

- **facts**: one per record entry, vault payment, spend permission, delegation, payment, redemption and
  credit-line event. Each names its source and carries a permission label, the block, transaction and log
  index, and the one-line command that returns the same log from any RPC.
- **selfDealing** (NablaZ accounts only): distinct counterparties paid, share of value paid to accounts
  under the same controller, share paid to counterparties with no record, and the sentence "A payee
  controlled by the same person under another key cannot be detected from chain data."
- **exposure** (NablaZ accounts only): per grant and token, the least remaining allowance across windows
  plus the vault balance, with the limit that outstanding authorizations are not observable onchain.
- **cShare**: per token, the count and value of this read's payment facts labelled (c), over all of them;
  never summed across tokens.
- **notes**: every source that returned nothing ("nothing indexed (blocks X..Y)", or "indexed up to X;
  source starts at Y" while the indexer is below the source's start), and every fact that is not
  determinable, stated as text.

Every permission label has one of five shapes:

| Shape | Label | Where it comes from |
|---|---|---|
| (a) | allowance, per period / total / per call / per execution / streamed | Coinbase spend permissions; MetaMask amount enforcers; NablaZ CAM V4 windows ("within mandate by construction" for a canonical NablaZ account) |
| (b) | exact execution, once / N times / count unbounded | MetaMask exact-call enforcers; the count from `LimitedCallsEnforcer` or a single-use enforcer |
| (c) | not determinable | an enforcer in no vendor list, terms that do not decode, a non-canonical NablaZ account |
| (d) | no limit on amount or call | a delegation whose caveats only restrict the call or the redeemer |
| (e) | third-party attestation, writer named | Agent Credit Lines; record entries another writer placed; ERC-8004 feedback, the rater named |

The MetaMask enforcer table is generated from the vendor's `Deployments.md` at a pinned commit
(`scripts/gen-enforcers.ts`, `src/generated/enforcers.json`). A test fails when the vendor's main branch
lists an enforcer the table lacks.

**One-liners are the ground truth.** The reader is a convenience over the logs. Each `reproduce` field is
a `cast` command you can run yourself with an RPC URL in `$ARB_ONE_RPC_URL` or `$BASE_RPC_URL`.

### Feedback grounding

When the subject has been the agentWallet or the owner of an ERC-8004 agentId, every `NewFeedback` about that
agentId becomes an `erc8004:feedback_grounding` fact (R-D2B-2). A feedback is grounded when an ERC-20
Transfer from the rater to the identity's payment address settled before it (by block, then by log index
within a block), whatever the token or route (R-S191-11). The payment address is resolved at the transfer's
block, never later: `getAgentWallet` there, else `ownerOf` there, and the fact says which binding applied
(R-S191-16). A transfer made before the identity existed does not ground ("identity did not exist at the
payment block"). The wallet at the feedback block is reported beside the grounding ("wallet at feedback:
<address>" or "wallet at feedback: cleared") and is never the test (R-S191-12).

Plain transfers are not indexed. At read time the reader calls `eth_getLogs` with topic0 = `Transfer` and
topic1 = the rater, any token address, from the Identity Registry's start block (or the instance's start) to
the feedback block, and states that range in the fact. Candidates are the addresses in the identity's
agentWallet history (`MetadataSet`) and owner history (ERC-721 `Transfer`), each confirmed at the transfer's
block. A settlement from the rater's own grantee vault is a payment from the rater (R-S191-17).
Native-token transfers are not read ("native-token transfers not read", R-S191-18). A transfer that is one of
the reader's payment facts keeps its permission label; any other is labelled (c) with reason "direct
transfer, no permission object". The fact also says whether the rater is the subject, and whether the two
share a controller when both are NablaZ accounts. It carries no value, decimals, tags or URIs, and the
feedback file is not fetched ("feedbackURI not read").

`test/fork/afg.fork.test.ts` runs this grounding on the 816 grounded feedback entries in Agentic Finance
Graph's Base fixture (CC BY 4.0, see NOTICE) and writes the comparison to
`docs/reader/afg-agreement-2026-10-20.csv`. `docs/reader/retroactive-binding-2026-10.md` describes the
remaining disagreements.

## Hosted read

Not live yet.

`https://read.nablaz.io` runs the reader and the MCP server below as one instance, on both home chains
(chain IDs 42161 and 8453), with every source indexed from its deployment block. It is keyless and reads
only. It has two doors:

- `GET https://read.nablaz.io/read/:chainId/:address`: the JSON a local `GET /read` returns.
- `POST https://read.nablaz.io/mcp`: the MCP server's Streamable HTTP transport, with its one tool,
  `read_subject`. For an MCP client that takes a URL: `{ "type": "http", "url": "https://read.nablaz.io/mcp" }`.

Both doors are rate-limited per client IP; a request over the limit gets 429 with a plain-text body. Nothing
else of the reader is served: no status, metrics or counts endpoint. Reads are taken at the indexed block and
cite the contracts' own logs and state, so each fact can be checked with its one-liner against an RPC of your
own. The deployment is `fly.toml` and `scripts/reader-start.sh`; `docs/runbooks/hosted-read.md` lists the
variables it reads and the database backup schedule.

## Running it locally

Everything below runs on your machine: the reader, the MCP server and the skill. Requires Node 22.12+ and
pnpm. From a clean checkout:

```sh
pnpm install --frozen-lockfile
export READER_ARBITRUM_RPC_URL=...             # Arbitrum One RPC; archive for the envelope and exposure reads
export READER_ARBITRUM_GROUNDING_RPC_URL=...   # Arbitrum One RPC for backfill eth_getLogs and grounding reads
export READER_BASE_RPC_URL=...                 # Base RPC
export READER_BASE_GROUNDING_RPC_URL=...       # Base RPC for backfill eth_getLogs and grounding reads
export PONDER_TELEMETRY_DISABLED=true
export READER_EXTERNAL_FROM=42161:518780000,8453:53160000   # optional; see below
pnpm reader                          # = cd packages/reader && pnpm start --schema reader
```

Each chain takes two RPC URLs, one per role, and both are required; one URL may serve both roles. The
first carries head tracking and the state reads. The second carries every `eth_getLogs` over a block range
(the backfill, and the grounding reads), so it should accept unlimited ranges. Head-tracking calls fall back
to it only when the first URL fails; the grounding reads never use the first.

The reader serves on `localhost:42069`. Once `/ready` answers 200 it has caught up, and reads are taken at
the indexed block:

```sh
curl localhost:42069/ready
curl localhost:42069/read/42161/0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c
```

Tables land in a local PGlite database under `packages/reader/.ponder/`. RPC URLs are read from the
environment only and are never written to the repository. With the `READER_EXTERNAL_FROM` line above, a
first run took about ten minutes to catch up on both chains (Oct 27 2026).

The third-party sources start at their deployment blocks, which is years of history.
`READER_EXTERNAL_FROM` starts them later, per chain. Facts before that block are then not indexed, and
the notes in each read state the range read. `READER_CHAINS=8453` limits the instance to one chain;
`READER_SOURCES=external` (or `nabla`) to one source group.

### MCP server

`packages/mcp` is an MCP server, on stdio by default, with one tool, `read_subject` (`chainId`, `address`). It calls
`GET /read/:chainId/:address` on the reader and returns the JSON unchanged, after a line naming the chain
and the as-of block. It reads only: there is no write or signing tool, and it holds no key. The reader URL
comes from `--reader-url` or `NABLAZ_READER_URL`, and defaults to `http://localhost:42069`.

```sh
pnpm --silent mcp                    # = cd packages/mcp && pnpm start
```

stdout carries the protocol, so launch it without anything that prints to stdout first (`pnpm` without
`--silent` prints a banner). For an MCP client that launches stdio servers from a JSON config:

```json
{
  "mcpServers": {
    "nablaz-read": {
      "command": "node",
      "args": ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "/path/to/nablaz-sdk/packages/mcp/src/main.ts"],
      "env": { "NABLAZ_READER_URL": "http://localhost:42069" }
    }
  }
}
```

#### HTTP transport

`--transport http` serves the same server, with the same single `read_subject` tool, over Streamable HTTP
at `POST /mcp`. It is stateless: no session, no key, no write or signing path. The port comes from `--port`
or `PORT` (default 3042). Requests are limited per client IP in process, `MCP_RATE_LIMIT_PER_MIN` per minute
(default 60), and a request over the limit gets 429 with a plain-text body. The client IP is the socket peer,
unless `MCP_CLIENT_IP_HEADER` names a header that a proxy in front overwrites with it (for example
`X-Real-IP`). Name only a header the proxy always sets: a header the client can send is a header the client
can spoof. `GET /read/:chainId/:address` and `GET /ready` are relayed to the reader unchanged, under the same
limit, so one port serves both doors. There are no CORS headers and no counts or metrics endpoint; every
other path returns 404.

```sh
pnpm --silent mcp -- --transport http --port 3042
```

To run the reader and the HTTP MCP server together as one instance over full history, use this
environment. Both chains are read, and every source starts at its deployment block:

```sh
READER_ARBITRUM_RPC_URL=...             # Arbitrum One RPC, archive: head tracking and state reads
READER_ARBITRUM_GROUNDING_RPC_URL=...   # Arbitrum One RPC, archive, unlimited eth_getLogs range
READER_BASE_RPC_URL=...                 # Base RPC, archive
READER_BASE_GROUNDING_RPC_URL=...       # Base RPC, archive, unlimited eth_getLogs range
PONDER_TELEMETRY_DISABLED=true
NABLAZ_READER_URL=http://localhost:42069
PORT=3042
MCP_RATE_LIMIT_PER_MIN=60
MCP_CLIENT_IP_HEADER=                # the client-IP header the proxy in front overwrites; unset without one
```

Leave `READER_EXTERNAL_FROM`, `READER_CHAINS`, `READER_SOURCES` and `READER_START_BLOCK` unset.

### Feedback grounding and the (c) share, locally

The ERC-8004 sources are part of the third-party group, so the run above indexes them; with
`READER_EXTERNAL_FROM`, they start at the same block as the other third-party sources. An agentWallet set
before that block is not seen, and the read says nothing indexed for it. Then:

```sh
curl localhost:42069/read/8453/<agentWallet>   # grounding facts, cShare, notes
```

The share of payment facts labelled (c) over the whole index, per token, over a block range (stop the reader
first: the script opens its database):

```sh
pnpm report:c-share 8453 53160000 53160200   # READER_PGLITE_DIR defaults to packages/reader/.ponder/pglite
```

It prints its inputs, one line per token, and the SQL that reproduces the count. Vault payments on
Arbitrum One are labelled through their account, which needs `READER_ARBITRUM_RPC_URL`.

### Skills

`skills/read-record/SKILL.md` explains how to call the tool or `GET /read`, how to read each source and
label shape, and what the reader never says. `skills/pay-inside-grant/SKILL.md` covers paying from a
grantee vault.

## Tests

```sh
pnpm typecheck
pnpm test          # unit
pnpm test:fork     # needs anvil and cast (Foundry) and the RPC variables below
NABLAZ_PROTOCOL_DIR=/path/to/nablaz-protocol pnpm test   # also checks the lineage copy against nablaz-protocol
```

The reader's fork tests read `READER_ARBITRUM_RPC_URL` (archive), `READER_BASE_RPC_URL` and their two
`*_GROUNDING_RPC_URL`; `packages/sdk`'s read `READER_ARB_RPC_URL` (archive).

The fork tests run an anvil fork of Arbitrum One, drive the live contracts from TypeScript using the
ABIs in `abis/`, index the result from scratch, and assert the derived rows. They index twice and require
identical tables. A separate test indexes Arbitrum One up to the block before the first account and
requires every table to come back empty. On both chains, a third test indexes the third-party sources over
a fixed window. It runs one rendered one-liner per source through `cast`, requires the same count as the
reader's rows, and prints the share of sampled redemptions labelled "not determinable". The account-grantee
test creates a NablaAccount on the live factory, makes it the grantee of a grant on the TEST account, and
settles one x402 payment whose grantee signature is the PersonalSign shape. The MCP test runs the stdio
server against a served reader and compares its output with `GET /read`.

## x402

The dependency floor is `@x402/*` ≥ 2.23.0, the fix line of the Oct 22 V12 disclosure (no default
spending limit in the client); this repo pins the version in `packages/sdk/package.json` (2.28.0), and the
payment limit is enforced by the grant envelope in the account, not by the client.

## Provenance

Contract addresses (`src/generated/addresses.ts`) and ABIs (`abis/*.json`) are generated from a pinned
nablaz-protocol commit; each generated file records the commit in its header. The reader's
`currentAccountImpl` lineage, bootstrap and ProtocolConfig (`packages/reader/src/generated/account-lineage.json`)
are copied from `script/expected/permanent-arbitrum.txt` at the commit and blob the file names
(`packages/reader/scripts/gen-lineage.ts`). Only addresses and ABIs
come from there: both are public on chain.

## License

MIT. See [LICENSE](LICENSE).
