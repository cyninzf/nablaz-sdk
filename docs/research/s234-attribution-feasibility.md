# S234 attribution feasibility (R-S234-2): ERC-8004 on Base, x402 facilitator scope

This was a read-only sitting: no build, no deploy, no env or flag change, and the reader untouched (one machine before
and after every console). The figures come from `s234-attribution-feasibility.mjs` beside this file, read on
2026-11-27 between 22:09Z and 22:37Z. Every number names its population. "Not measured" means it was not measured.

Ruling served (R-S234-2): one attribution object per fact,
`{identityRef?, displayName?, rail, railClass, medium, kind, grade a|b|c, citations}`. The grades:
(a) evidenced agent identity; (b) rail and provider in human words; (c) undetermined, stated. Inference is never a
grade. ERC-8004 Identity is admitted; 8004 Reputation signals never are.

## Summary

| § | Question | Answer |
|---|---|---|
| A1 | Identity Registry on Base | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, derived from the vendor README and verified on the rail |
| A2 | Registrations on 8453 | **1,231,427** (agentIds 0..1,231,426, to block 63,138,341). The DB agrees exactly. Event shape and URI availability are below |
| A3 | Overlap with our 8453 subjects | **Not measured.** The console session was cut twice and the DB lane was stopped under the pre-decided rule. Both populations were measured; their intersection was not |
| A4 | Resolvable rate on the overlap set | **Not measured** (it depends on A3). A registry-wide rail sample was taken instead and is labelled as such: 276/300 pass the test as written, but 270 of the 300 sit on one host, so the test does not separate a bulk platform from an agent |
| B | x402 facilitator attribution | **Indexing-side: REINDEX-CLASS.** Nothing clears today. The only API-layer part is the signer→provider map, and only 1 of 15 listed facilitators publishes signers |

## A1. The Identity Registry address, derived

- Source: `erc-8004/erc-8004-contracts` README.md at the repo HEAD `b9e466c250744a7e06b13dff9d3c2844ed64f825`, block
  "#### Base Mainnet", line `IdentityRegistry`. The address is `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.
  The script reads it from the README every run; it is never typed in.
- That HEAD is the vendor commit the reader already pins (`packages/reader/src/generated/erc8004.json`), and the
  pinned address is equal.
- Verified on the rail (Base, chain id 0x2105, block 63,142,954):
  - Proxy code is 130 bytes. The EIP-1967 implementation slot holds `0x7274e874CA62410a93Bd8bf61c69d8045E399c02`,
    with 14,474 bytes of code.
  - `name()` = "AgentIdentity", `symbol()` = "AGENT", `getVersion()` = "2.0.0".
  - `supportsInterface` is true for both ERC-721 (`0x80ac58cd`) and ERC-721 Metadata (`0x5b5e139f`).

## A2. Registrations on 8453

- **Event shape** (vendor `abis/IdentityRegistry.json` at the same commit):
  `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`,
  topic0 `0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a`.
  - Every `register(...)` also emits `MetadataSet(agentId, "agentWallet", …, msg.sender)`. The initial agentWallet is
    the registrant (`IdentityRegistryUpgradeable.sol`).
  - The agentURI is a string in the event, and `tokenURI(agentId)` returns the current one. `setAgentURI` emits
    `URIUpdated`.
- **Total: 1,231,427 registrations** up to block 63,138,341.
  - Method: agentIds are sequential from 0 (`agentId = $._lastId++`). The newest `Registered` is agentId 1,231,426
    (tx `0xe83db4c35e9fc9e50904bd246029efae2107561ad86f7c88d59ca7fe73d13460`).
  - Check at that block: `ownerOf(1231426)` returns an owner and `ownerOf(1231427)` reverts.
  - Cross-check with our record: the reader's `agent_owners` on 8453 held 1,231,425 agentIds (max 1,231,424, 0 burns),
    indexed to block 63,134,279. The rail at block 63,134,249 read 1,231,425 registrations. **Exact match.**
  - `agent_wallets` 8453: 2,367,407 rows, of which 1,231,741 are non-null (set) and the rest clears.
- **Registration-file URI availability**, two stated populations:
  - Registrations in the last 1,800 blocks (about 1 h): 5 in the first read, all `https://`. The second read
    (a later hour) found 0.
  - Registry-wide sample: 300 agentIds evenly spaced over all 1,231,427
    (`floor(i·N/300) + (i mod 7)`, `tokenURI` at latest):

    | Scheme | Count |
    |---|---:|
    | https | 290 |
    | data: | 5 |
    | ipfs | 1 |
    | empty | 4 |

    That is **296/300 (98.7%) non-empty**.

## A3. The join: overlap with our 8453 subjects (not measured)

**Not measured: the console session was cut twice; the DB read gets its own window.** The two cuts are recorded below
as observed facts.

**Cut 1.**
- When: the session opened at 2026-11-27 22:10:23Z and ended with pg `Connection terminated unexpectedly`. The exact
  second of the cut was not captured; it was before about 22:20Z.
- Query shape: one statement, in one `READ ONLY` repeatable-read transaction (`statement_timeout` 900 s,
  `work_mem` 64 MB):
  - CTEs taking `SELECT DISTINCT lower(<address>)` over `external_permissions`, `external_payments`,
    `vault_payments`, `agent_owners` and `agent_wallets` on 8453.
  - A `DISTINCT ON (agent_id)` over `agent_owners`.
  - Eleven scalar-subquery counts.
- The statements before it (two counts over `agent_owners` / `agent_wallets`) had answered.
- **Unverified cause:** `lower()` on the indexed hex columns defeated their `(chain_id, address)` indexes. That forced
  hash/sort DISTINCTs over about 6M rows on a basic-plan Managed Postgres, and the server or its proxy dropped the
  session. Neither the Postgres logs nor a server-side reason were read, so this stays unverified.
- Reader during and after: same machine `850dd3a4113e78`, with no restart event since 2026-11-26T22:45Z.
  `/ready` answered 200 and `/feed?limit=1` answered 200. Indexing logs continued at 22:24Z.

**CTO ruling after cut 1:**
- Re-run once in a light form: lowercase on the parameter side only, no function on any indexed column, and
  index-driven batched statements with `statement_timeout` 120 s each.
- Check reader health before and after.
- Any second cut ends the lane.

**Cut 2.**
- When: from 22:29:31Z to 22:35:09Z.
- Query shape: the light form, 311 statements, all of them keyset pages of 50,000 rows over the existing
  `(chain_id, address)` indexes (`where chain_id = $1 and col > $2 order by chain_id, col limit 50000`).
- **Every DB statement answered.** The session ended because the console's own Node process ran out of heap
  (`FATAL ERROR: Reached heap limit … JavaScript heap out of memory`, V8 stack in the run output). It was holding the
  2.27M-address owner set beside the other three sets on a 1,024 MB VM with Node's default heap.
- This cause is verified from the stack.
- Per the stop rule, the lane ended there.
- Reader health (`/ready`, `/feed?limit=1`):

  | | `/ready` | `/feed?limit=1` |
  |---|---|---|
  | Before | 200 in 41 ms | 200 in 74 ms, 1 item |
  | After | 200 in 42 ms | 200 in 41 ms, 1 item |

  One machine before and after.

**What cut 2 did measure** (distinct addresses on 8453, from the live schema
`deployment-01m89nandm6z68gdjf7nfbbb9k` at 22:29:43Z). These are the two sides of the join; their intersection was
not computed:

| Side | Column | Non-null rows | Distinct |
|---|---|---:|---:|
| Our subjects | grant subjects (`external_permissions.subject`) | 1,028,653 | **236,947** |
| Our subjects | payment subjects (`external_payments.payer`) | 1,808,562 | **227,984** |
| ERC-8004 bound | ever-agentWallet (`agent_wallets.wallet`) | 1,231,741 | **1,150,958** |
| ERC-8004 bound | ever-owner (`agent_owners.owner`) | 2,356,171 | **2,273,424** |

For the next window, the fix is in the script, not the database: stream one side and probe the other. Load our
subjects, about 0.4M distinct, into memory. Then probe the 8004 tables with `wallet = any($1)` / `owner = any($1)` in
chunks. Or raise the console's `--max-old-space-size`. Either way, the DB statements stay as they were in cut 2.

## A4. Placeholder guard: the resolvable rate

**On the overlap set: not measured** (it depends on A3).

**On the registry-wide rail sample** (the same 300 agentIds as A2; rail and HTTP only, no DB). This is a different
population from the overlap set and must not be read as its rate.
- Resolvable = a valid file AND at least one live endpoint:
  - Valid file: a JSON object with a non-empty `name` and a `services` (or legacy `endpoints`) array.
  - Live endpoint: an http(s) service endpoint answering one GET with a status from 200 to 499, except 404 and 410,
    within 10 s.
  - The file is fetched directly for https, through `ipfs.io` for ipfs, and decoded for `data:`.

| Step | Count | % |
|---|---:|---:|
| Non-empty URI | 296/300 | 98.7% |
| File fetched | 293/300 | 97.7% |
| JSON | 292/300 | 97.3% |
| `type` = `…eip-8004#registration-v1` | 289/300 | 96.3% |
| Valid file | 289/300 | 96.3% |
| Valid with ≥1 http(s) endpoint | 287/300 | 95.7% |
| **Resolvable** | **276/300** | **92.0%** |
| Resolvable, strict (a 2xx) | 275/300 | 91.7% |

**Concentration: this is what the guard must see.**
- 270 of the 300 sampled agentURIs are on **one host**, `centralcity.ai`, and the first endpoint of all 270 is on the
  same host.
- The next hosts are a single S3 bucket (10), `data:` (5), `taskmarket.dev` (4) and `arweave.net` (2).
- The 276 resolvable files carry 276 distinct names.
- **Off that one host, 6 of 30 are resolvable.**

Read: the naming law ("render a name only from a resolvable file") passes a single platform's bulk-minted
identities: each has a well-formed file, a unique name and a live endpoint, all served by the platform itself. As
defined, "resolvable" proves that a file and an endpoint exist. It does not prove they belong to a distinct agent.
That is for the ruling to weigh; this sitting proposes no rule.

## B. x402 facilitator attribution (the rung (b) engine)

**What the attribution needs, from which contracts and events.** Read at `@x402/evm` 2.28.0 (the SDK's pinned version),
`coinbase/x402@0e6e8c55d86b4f14234fb6e49a4052074fb93e57`, and on the Base rail.

1. **The settlement log** (`kind`, `citations`):
   - The `exact` scheme on USDC settles through EIP-3009 `transferWithAuthorization`. That emits USDC
     `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` and the paired `Transfer`.
     Base USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
   - Permit2-route tokens settle through `x402ExactPermit2Proxy` `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` or
     `x402UptoPermit2Proxy` `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`. Both are deployed on Base (2,913 and
     3,142 bytes). Their `Settled()` / `SettledWithPermit()` carry **no fields**, so payer, payee and amount come
     from the token `Transfer` in the same receipt.
2. **The facilitator** (`rail` provider): the settling transaction's **`from`**, the facilitator's signer. It is a
   transaction field and appears in no log.
   - EIP-3009 `AuthorizationUsed` is generic: it is not x402 by itself.
   - Only a sender that is a published facilitator signer, or the proxy contracts, evidences the x402 rail. Anything
     else would be inference and grades (c).
3. **The provider in human words** (`displayName` of the rail): the facilitator's own `GET /supported` →
   `signers["eip155:*"]` (the `@x402/core` facilitator API). This is off-chain and self-published.

**Measured:**
- Facilitators publishing Base signers: **1 of 15** listed in `docs/dev-tools/facilitators.md`. Each listed URL
  was probed with `/supported` appended.
  - PayAI: Base kinds, 15 EVM signers.
  - Mogami: Base kinds, no `signers` field (v1 only).
  - NEAR x402: no Base kind.
  - The other 12 (CDP among them) answer no `/supported` JSON at their listed URL, which is a docs or landing page.
  - So the CDP facilitator's signers are **not found** from the official list.
- Base, blocks 63,140,877..63,142,676 (1,800 blocks, about 1 h):
  - USDC `AuthorizationUsed`: **453** logs in 453 txs.
  - Of a 300-tx sample: 39 distinct senders, and **2/300** sent by a published signer (PayAI).
  - Permit2-proxy logs: 7.
- Our own 8453 payment facts against those signers: **not measured** (the sample came from the DB lane, which stopped).

**Indexing vs API layer** (the S233 Task 3 test: can it be served from already-indexed rows in `src/api`?):
- **Indexing-side.** The record holds **no x402 settlement fact on 8453**:
  - USDC `AuthorizationUsed` is a source only on chains with a NablaZ record (`perChain` in `ponder.config.ts`),
    which on Base means none.
  - Where it is a source, `Usdc:AuthorizationUsed` in `src/index.ts` drops every non-vault authorizer.
  - Neither Permit2 proxy is a source.
  - No row stores a transaction's `from`.
- Carrying x402 facts with a facilitator needs:
  - new sources (Base USDC `AuthorizationUsed`, the two proxies) in `ponder.config.ts`;
  - a handler that keeps them;
  - a column for the settling tx's `from` (`ponder.schema.ts`).
- All three are build-id inputs. **The build id moves off `fe32cfae51`: REINDEX-CLASS.** The banked `src/read.ts` Fact
  rider boards that same future deploy. **The deploy is not this sitting's to run.**
- **API-layer part:** the signer→provider map (a pinned snapshot of facilitators' `/supported`) and its rendering into
  `rail` / `displayName`. These can live in `src/api` with the build id held, but they have no x402 facts to attach to
  until the reindex.
  - Annotating facts we already hold (SPM and DelegationManager payments) with a facilitator would cost one
    `eth_getTransactionByHash` per item at serve time.
  - Whether any of them is facilitator-sent is not measured.

**Both lanes, stated:**
- Rung (a), ERC-8004: the address is derived, the registrations are counted, and the DB matches the rail. The join
  is not measured, and the guard as defined does not separate a bulk platform from an agent. **Nothing clears today.**
- Rung (b), x402: the engine is reindex-class, and 1 of 15 facilitators publishes its signers. **Nothing clears
  today.**

## Re-running

```bash
node docs/research/s234-attribution-feasibility.mjs                       # all parts
node docs/research/s234-attribution-feasibility.mjs --parts=rail,registry,x402   # rail and HTTP only, no DB
```

- Needs the Base RPC env named by `CHAINS[8453].rpcEnv` in `packages/reader/src/chains.ts`. The `join` part needs `~/.fly/bin/flyctl` with access to the app.
- As committed, the `join` part is the cut-2 light form. **It will hit the same console heap limit.** Change it as
  noted under A3 before giving it its window.
