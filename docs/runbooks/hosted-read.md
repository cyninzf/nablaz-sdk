# Hosted read on Fly

The hosted instance at `read.nablaz.io` (R-S193-1) is one Fly app, `nablaz-reader`, running one instance with
two doors (R-S192-1): the reader, and the HTTP front of `packages/mcp`, which serves `POST /mcp` and relays
`GET /read` and `GET /ready` to the reader. `fly.toml` is the app definition; `scripts/reader-start.sh`
starts both processes. No secret is in the repository: every value below is a Fly secret, set by Fly, or
set in `fly.toml`.

## Variables

| Variable | Value |
| --- | --- |
| `READER_ARBITRUM_RPC_URL` | Chainstack, chain 42161: head tracking and state reads |
| `READER_ARBITRUM_GROUNDING_RPC_URL` | Alchemy, chain 42161: backfill `eth_getLogs` and grounding reads |
| `READER_BASE_RPC_URL` | Chainstack, chain 8453 |
| `READER_BASE_GROUNDING_RPC_URL` | Alchemy, chain 8453 |
| `MCP_CLIENT_IP_HEADER` | `Fly-Client-IP`, the client-IP header Fly's edge sets |
| `DATABASE_URL` | set by `fly mpg attach nablaz-reader-db -a nablaz-reader`, not in `fly.toml` |
| `MCP_RATE_LIMIT_PER_MIN` | optional, default 60 |

The first five are Fly secrets. `PORT` is pinned to 3042 in `fly.toml`, equal to `internal_port`.
`FLY_IMAGE_REF` is set by Fly. Leave `READER_EXTERNAL_FROM`, `READER_CHAINS`, `READER_SOURCES`,
`READER_START_BLOCK` and `READER_END_BLOCK` unset: every source starts at its deployment block. The start
script refuses to start without the four RPC variables, `MCP_CLIENT_IP_HEADER`, `DATABASE_URL`, `PORT` and
`FLY_IMAGE_REF`.

RPC roles (src/rpc.ts, R-S192-8): the grounding reads use the grounding URL only. The indexer sends range
`eth_getLogs` (backfill) to the grounding URL, and everything else to the Chainstack URL, falling back to the
grounding URL only when the Chainstack URL fails. A range `eth_getLogs` over 10,000 blocks is never sent to the
Chainstack URL.

## Deploys

`fly.toml` builds the root `Dockerfile`, whose CMD runs `scripts/reader-start.sh` as the non-root user
`reader`. One machine (`min_machines_running = 1`, `auto_stop_machines = false`): the rate limit is held in
process, and one indexer writes the database. Each deployment indexes into its own schema, named from the
deployment's image tag in `FLY_IMAGE_REF`; the views schema `reader` points at the deployment that is live. The
RPC cache (schema `ponder_rpc_cache_1`) is shared, so a redeploy reindexes from the cache rather than from the RPCs. Ponder 0.18 names the RPC cache schema `ponder_rpc_cache_1`; `ponder_sync` is the legacy name (sync-store/schema.ts). Ponder does not drop the schema of a deployment
that has been replaced; replaced schemas are dropped by hand once the new deployment is live.

The deploy command, exactly as it ran on 2026-11-05 (R-S194-4 form): from the repo root, with `origin/main`
checked out detached (`132804ab0489f788fc35a60e91beca84ef0f9f23`, tree equal to `origin/main`'s), stdin from
`/dev/null` so an interactive question fails instead of waiting:

```
~/.fly/bin/flyctl deploy -a nablaz-reader --ha=false < /dev/null
```

`fly.toml` as is: the root `Dockerfile`, the default remote builder (Depot), the `/live` check with its 60 s grace,
no other flags. It ran 14:00:34Z to 14:02:21Z, exit 0, no prompt, and produced
`registry.fly.io/nablaz-reader:deployment-01M6P05TWT15F0PB31GR64T2P3`; still one machine (`850dd3a4113e78`),
`/live` 200 and `/ready` 503 at 14:02:26Z.

Timings on record (`/ready` 503 until the index is ready):
- Same image, same schema (a `machine update` or restart, Ponder replays from its own schema): about 13 min
  (2026-11-04, 16:05:24Z to 16:18:15Z).
- New image, new schema (a full index from the RPC cache): about 7 h (2026-11-05, from 14:02Z). It is bound by
  the indexing handlers, not by the RPCs.

### Resuming a schema (R-S202-4, S202)

When the new image computes the same Ponder build id as a deployment whose schema exists, the deploy can resume
that schema instead of indexing a new one. Ponder 0.18.1 derives the build id at `build/index.ts:567` from three
hashes: the evaluated config (`ordering`, `contracts`, `accounts`, `blocks`: addresses, ABIs, filters and start
blocks, so the `READER_*` variables and the ABIs from `packages/sdk` count; RPC URLs and the database do not),
the raw text of `ponder.schema.ts`, and the raw text of every `src/**/*.{js,mjs,ts,mts}` file. `src/api/**`
and `*.test.*`/`*.spec.*` are excluded, so an API-only or front-only change keeps the id, and any other change
under `packages/reader/src/` (imported by a handler or not) moves it. To check: between the live image's commit and
the next one, nothing changed in `packages/reader/ponder.config.ts`, `packages/reader/ponder.schema.ts`,
`packages/reader/src/` outside `src/api/`, or the ABIs and addresses in `packages/sdk`, and the `READER_*`
variables are unchanged. The id Ponder recorded is in the schema's `_ponder_meta` row (`key = 'app'`, field
`build_id`), read from an ephemeral console as above. If the id is unchanged, deploy with the override:

```
~/.fly/bin/flyctl deploy -a nablaz-reader --ha=false --env READER_SCHEMA=<schema> < /dev/null
```

`scripts/reader-start.sh` then starts Ponder on `<schema>` instead of the image tag. Ponder rolls the tables back
to the safe checkpoint (it drops the schema's indexes and reverts rows written after it, with `is_ready` back to
0), re-indexes the gap to the head, rebuilds the indexes, re-points the `reader` views and sets `is_ready`; `/read`
answers 503 `{"ready":false}` until then (below). A mismatched build id crash-loops at start ("Schema … was
previously used by a different Ponder app") and nothing is dropped: redeploy without the override, which indexes
into the new image's own schema.

## Health: /live and /ready

- `GET /live` is deploy health, and Fly's check (`fly.toml`, 60 s grace). It answers 200 when the front is up
  and the reader process runs, whatever the index progress; 503 otherwise. `scripts/reader-start.sh` passes the
  reader's PID as `NABLAZ_READER_PID`, so the front checks the process (`kill(pid, 0)`) and never calls into
  Ponder's event loop: a long block in Ponder does not fail Fly's check (R-S194-15). Without the PID, `/live`
  asks the reader's `/health`.
- `GET /ready` is index readiness, the public signal: 503 until the index has caught up, 200 after. `/ready`
  503 during backfill is expected, not an incident.

## /read

- Readiness gate (R-S202-4): `GET /read/:chainId/:address` and the MCP `read_subject` tool answer 503
  `{"ready":false}` (the tool: an error result carrying `{"ready":false}`), and read nothing, whenever the index is
  not ready, in the same vocabulary as `/ready` (R-S193-13). Both doors use one check in the front
  (`readerReadiness`, `packages/mcp/src/server.ts`): the reader's own `/ready`, which Ponder answers from the
  running app's `is_ready`. An empty record from an unready schema is absence, not a record (R-S189-6). Evidence:
  the S202 public probe at 15:48Z, on an image whose `/ready` was 503, returned `facts: []` with
  `asOfBlock` 445102197 in 66 to 71 s, and an intermittent 500.
- Open row: serve reads through the reader views. `/read` reads Ponder's `db` from `ponder:api`, which is the
  running deployment's own schema, not the `reader` views that point at the live one; until it does, a new
  deployment has nothing to serve before it is ready, and the gate above answers `{"ready":false}`.

## Database backup (off-platform)

`pg_dump` runs daily from a host outside Fly, over the database's external connection string, held only in
that host's environment as `NABLAZ_READ_DATABASE_URL`. Fourteen dumps are kept. The `pg_dump` major version
must be at least the server's.

```cron
# m h dom mon dow   daily at 03:15 UTC
15 3 * * *  pg_dump --format=custom --no-owner --no-privileges --dbname="$NABLAZ_READ_DATABASE_URL" --file="$BACKUP_DIR/nablaz-read-$(date -u +\%Y\%m\%dT\%H\%MZ).dump" && find "$BACKUP_DIR" -name 'nablaz-read-*.dump' -mtime +14 -delete
```

Restore into an empty database with `pg_restore --no-owner --dbname="$TARGET_DATABASE_URL" <dump>`; it holds
`ponder_rpc_cache_1` and every deployment schema present when the dump was taken.

## Start-up RPC check, leg tags and RPC counters

- Before Ponder starts, `scripts/reader-start.sh` runs `packages/reader/scripts/check-rpc.ts`: each of the four
  RPC variables must answer `eth_chainId` with its chain's id, and `eth_blockNumber`. It tries up to 3 rounds, 5 s
  apart, and logs one line per leg, by variable, chain, role and host (never the path or key). A leg that still
  fails is named in a warning, `rpc check FAILED: READER_..._URL (<chain> <role>, host <host>): <reason>` then
  `rpc check WARNING: <n> of 4 legs failed: <variables>; starting anyway`, and the start goes on (CTO ruling,
  S200: a boot-blocking check would restart-loop on any vendor outage, the Oct 30 exit-75 class). An ongoing leg
  failure shows in `/metrics/reader`.
- Every RPC error the reader logs starts `[rpc <chain> <leg>]`, leg `indexer` (Chainstack) or `grounding`
  (Alchemy) (R-S194-10). URLs inside the error are already `[redacted:indexer]` / `[redacted:grounding]` (R-S197-8).
- `GET /metrics/reader` on the reader's loopback port (127.0.0.1:42069, beside Ponder's own `/metrics`) serves
  per chain and leg `nablaz_rpc_requests_total`, `nablaz_rpc_errors_total`, `nablaz_rpc_rate_limited_total`,
  `nablaz_rpc_rate_limited_recent` (1 for 60 s after a 429), `nablaz_rpc_last_error_timestamp_seconds` and
  `nablaz_rpc_last_rate_limited_timestamp_seconds`. Counters start at 0 on each start. The front never relays it.

## Operator method

Every command below is the form that ran on the hosted instance; copy it, do not retype it.

### Step 0 of every relay (S199)

The SE's repository is `/workspaces/nablaz-sdk` (the codespace `nablaz-sdk`). The codespace has no `gh`; PR counts
are read token-side by the CTO, not by the SE.

```bash
cd /workspaces/nablaz-sdk && git fetch origin && git rev-parse origin/main
```

### Commands sent with `-C` (S195-L3)

"flyctl ssh console -C strips backslashes — no backslash rides -C; use String.fromCharCode or --file-local
scripts." (S195-L3)

S200-proven: in bash double quotes a backslash is consumed only before `$` `` ` `` `"` `\` — so `\"` never
reaches flyctl, while `\|` passes through and flyctl strips it (the S198 attempt: "flyctl stripped the backslashes
and the shell exited 127").

`-C` runs the command without a shell: a glob such as `/proc/[0-9]*` is not expanded unless the command is
wrapped in `sh -c '...'` (S200, check 8).

### Ponder's metrics, from inside (Step S)

Ponder serves `/metrics` on 127.0.0.1:42069 only. The Step-S line, as it ran on 2026-11-04 (output to a local file,
then grep `^ponder_sync_block|^ponder_sync_is_realtime` locally):

```bash
~/.fly/bin/flyctl ssh console -a nablaz-reader -C "node -e \"fetch('http://127.0.0.1:42069/metrics').then(r=>r.text()).then(console.log)\"" > metrics.txt
```

`/metrics/reader` (above) is read the same way, with that path. Not from record: it is new in this PR and has not
yet been read on the hosted instance.

### Memory per process (check 8, amended S199)

PID 1 is Fly's init, not node (R-S198-2 / S198-L4); read every process's own `/proc/<pid>/status`. The relay's
unwrapped form failed (`grep: /proc/[0-9]*/status: No such file or directory`); the form that ran:

```bash
~/.fly/bin/flyctl ssh console -a nablaz-reader -C "sh -c 'grep -H -E \"Name|VmHWM|VmRSS\" /proc/[0-9]*/status'"
```

Report `Name`, `VmHWM` and `VmRSS` in kB for each `node` process (there are two: the reader and the front).

### Ephemeral console with the app's DATABASE_URL (R-S194-7, check 10)

R-S194-7 (method, verbatim): "write the script locally, run via flyctl console -a nablaz-reader --vm-size
shared-cpu-1x --vm-memory 1024 --file-local /tmp/x.sh=x.sh -C "bash /tmp/x.sh"; pg package at
/app/node_modules/.pnpm/pg@*/node_modules/pg; the image has no curl/top — node fetch and /proc; console
self-destroys; verify exactly ONE machine after."

The proven form (S200) ships both files, `x.sh` and the `.mjs` it runs, with two `--file-local` flags:

```bash
~/.fly/bin/flyctl console -a nablaz-reader --vm-size shared-cpu-1x --vm-memory 1024 --file-local /tmp/x.sh=x.sh --file-local /tmp/pgcount.mjs=pgcount.mjs -C "bash /tmp/x.sh"
```

`/tmp/x.sh` (the ESM fix: pass the lib entry, not the package directory):

```bash
P=$(ls -d /app/node_modules/.pnpm/pg@*/node_modules/pg | head -1); node /tmp/pgcount.mjs "$P/lib/index.js"
```

`/tmp/pgcount.mjs` (the import reads `.default`):

```js
const mod = await import(process.argv[2]);
const { Client } = mod.default;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query("select count(*)::int as total from pg_stat_activity");
console.log(JSON.stringify(r.rows[0])); await c.end();
```

Then `~/.fly/bin/flyctl machines list -a nablaz-reader`: exactly one machine.

Check 10 is a session COUNT against the database's limit of 50, nothing more: the app's role (`schema_admin`)
cannot see other sessions' `state` in `pg_stat_activity` (S197-L5). On 2026-11-04 it read `{"total":19}`.

### The hosted (c) share (R-S194-9, R-S190-3)

`scripts/c-share.ts` reads the hosted Postgres index when `DATABASE_URL` is set (the views schema `reader`, while
the reader runs). From an ephemeral console as above, with `x.sh` holding
`cd /app/packages/reader && node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/c-share.ts <chainId> <fromBlock> <toBlock>`.
For a vault payment's label it reads the chain's RPC (`READER_ARBITRUM_RPC_URL`), present on the console machine.

Population (2026-11-05): Arbitrum 42161 from block 283144909 = min(SpendPermissionManager 283144909,
DelegationManager 320575464, NablaZ 516635193), per `startBlockOf` in `src/chains.ts`; Base 8453 from block
23499060. The TEST account `0x8E65…b11c` is cited to `README.md` and the reader tests.

The first hosted run (2026-11-05) failed on the loader: exit 1 on both chains, `loadPgFromPonder` returned null.
Under plain node, `createRequire` on the pnpm link `node_modules/ponder` searched the link's parents, where pg is
absent; the loader now resolves Ponder's real directory first (s202-c-share-loader), and a unit test runs it under
plain node without `NODE_PATH`.

### Logs

`~/.fly/bin/flyctl logs -a nablaz-reader --no-tail` returns the last 100 lines only (S200: 100 lines, about 18 s,
both reads). It cannot reach an earlier day. Mask URLs before printing any line.

### Restart policy and exit 75 (S196–S197 record)

"restart-policy behavior row (exit 75 → flyd loop → autostart on next request)". Observed: "reader crash-looped
exit 75 from ~12:32Z Oct 30 under flyd policy"; "pipeline frozen on BOTH chains after two exit-75 restarts
20:46:49Z/21:01:00Z Oct 30; restart unfroze" (one restart by ruling 15:12:29Z Oct 31 unfroze it).

Not from record: exit 75 is Ponder's own exit code; from inside the image it does not say which failure caused
it. The start-up RPC check never stops the start; its warning names a leg that failed at boot. A restart after a
replace (machine update or deploy) took about 13 min of `/ready` 503 on 2026-11-04 (16:05:24Z to 16:18:15Z) while
Ponder replayed from its cache; `/live` stayed 200.

### Postgres timeouts are the client's (S198 §6)

"Ponder's read-only pool sets statement_timeout 30 s + work_mem 512MB itself (Postgres default is 0 — the limit
is the client's, S197-L2 class)".

## Secrets rotation

- R-S196-2: "a rotation is verified by DIGEST CHANGE, never by operator report."
- R-S194-14: "staged secrets bind via fly machine update, never fly secrets deploy; 'Staged' = bookkeeping."
- R-S196-3: "Fly 'Staged' status is app-release bookkeeping — binding is proven by behavior."

Staging: the new value is read with hidden input and sent on stdin, never on a command line:
`flyctl secrets import --stage -a nablaz-reader`, one `NAME=VALUE` line per secret. Compare
`flyctl secrets list` digests with the deployed ones before binding; an unchanged digest stops the rotation.
Binding, the one machine-touching step:

```bash
~/.fly/bin/flyctl machine update 850dd3a4113e78 -a nablaz-reader --yes
```

After the bind `secrets list` may still show `Staged` (R-S196-3). Behavior proves the bind: every leg answers
`eth_blockNumber` from inside, hosts only:

```bash
~/.fly/bin/flyctl ssh console -a nablaz-reader -C "node -e \"(async()=>{for (const k of ['READER_ARBITRUM_GROUNDING_RPC_URL','READER_ARBITRUM_RPC_URL','READER_BASE_GROUNDING_RPC_URL','READER_BASE_RPC_URL']) { const u = process.env[k]; const h = new URL(u).host; try { const r = await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]})}); const j = await r.json().catch(()=>({})); console.log(k, h, 'http=' + r.status, j.result ? 'head=' + parseInt(j.result,16) : 'err=' + String(j.error && (j.error.code + ' ' + j.error.message) || 'nobody').replace(/https?:[^ ]+/g,'[url]').slice(0,80)) } catch (e) { console.log(k, h, 'fetchfail=' + e.name) } }})()\""
```

### Rotation record: R-S200-1 (2026-11-04)

The Alchemy key on both grounding legs (`READER_ARBITRUM_GROUNDING_RPC_URL`, `READER_BASE_GROUNDING_RPC_URL`) was
rotated. The app of record is the Alchemy app "NablaZ Reader"; "Hosted Reader" in earlier records was a
mislabel. Digests `ea32936f4c940293` / `55aed7250fb04c12` became `53c1012a5c6d0fa2` / `83566ff914e08775`; bound by
`machine update` 16:04:11Z to 16:05:24Z; `/ready` 200 at 16:18:15Z; both Alchemy legs answered on the new key.

Attribution addendum: to confirm which Alchemy app a key belongs to, send 25 `eth_blockNumber` per grounding leg
from inside (50 calls), then read the tick on the Alchemy dashboard for that app. The burst that ran (16:21:25Z,
25 of 25 ok per leg, landed on "NablaZ Reader"):

```bash
~/.fly/bin/flyctl ssh console -a nablaz-reader -C "node -e \"(async()=>{console.log('start=' + new Date().toISOString()); for (const k of ['READER_ARBITRUM_GROUNDING_RPC_URL','READER_BASE_GROUNDING_RPC_URL']) { const u = process.env[k]; const h = new URL(u).host; let ok = 0, bad = 0, codes = {}, last = 0; for (let i = 0; i < 25; i++) { try { const r = await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:i,method:'eth_blockNumber',params:[]})}); const j = await r.json().catch(()=>({})); codes[r.status] = (codes[r.status]||0) + 1; if (r.status === 200 && j.result) { ok++; last = parseInt(j.result,16) } else bad++ } catch (e) { bad++; codes[e.name] = (codes[e.name]||0) + 1 } } console.log(k, h, 'ok=' + ok, 'fail=' + bad, 'codes=' + JSON.stringify(codes), 'lastHead=' + last) } console.log('end=' + new Date().toISOString())})()\""
```

The GitHub Actions secrets `READER_ARB_RPC_URL` and `READER_BASE_RPC_URL` (the fork tests) carry an RPC URL too.
On 2026-11-04 they still carried the rotated key: every fork call answered HTTP 401 "Must be authenticated!".
A rotation updates them as well.

## Defaults (S198-L3)

Every load-bearing default is set in the repository or accepted here with its reason.

| Default | Value | Set or accepted |
| --- | --- | --- |
| Ponder `pollingInterval` | 1000 ms | Set for Base (2000 ms, `ponder.config.ts`); accepted for Arbitrum: Ponder fetches every new block there, so a longer interval saves no calls (S192 measurement). |
| Ponder `ethGetLogsBlockRange` | unset | Accepted: per chain, it would cap the Alchemy leg too; the Chainstack cap (10,000 blocks) is held in `src/rpc.ts`. |
| Ponder per-request transport options | `retryCount: 0`, `timeout: 10_000` | Accepted: Ponder retries and load-balances itself (`ponder/dist/esm/rpc/index.js`). |
| viem `maxResponseBodySize` | 10,485,760 | Set to 32 MiB on every leg (R-S197-7). |
| viem client retries on the grounding client | 3, exponential from 150 ms | Accepted: grounding reads are served per request; a retry costs one more call, not a wrong answer. |
| Ponder Postgres pool `max` | 30 | Accepted: 2 internal plus 9 each for the read-only, user and sync pools under `ponder start`; 19 sessions read on 2026-11-04 against the limit of 50. |
| Ponder pool timeouts | read-only: `statement_timeout` 30 s, `work_mem` 512MB, `lock_timeout` 500 ms; user and sync: `statement_timeout` 2 min; internal: 10 min | Accepted: Ponder sets them on its own clients (S198 §6); a `/read` query over 30 s is fixed by an index (S198, #10), not a longer timeout. |
| Ponder `ordering` | multichain | Set: `omnichain`. |
| Fly restart policy | not set in `fly.toml` | Accepted with the record above (exit 75 → flyd loop); the start-up RPC check warns and never exits non-zero, so it adds no restart. |
| Fly `http_service` check | Fly's, not relied on | Set: `GET /live`, 15 s interval, 5 s timeout, 60 s grace. |
| Fly autostop | Fly's, not relied on | Set: `auto_stop_machines = false`, `min_machines_running = 1`. |
| Front rate limit | 60 per IP per minute | Set: `DEFAULT_RATE_LIMIT_PER_MIN`, keyed by `Fly-Client-IP`. |
| Front relay fetch timeout | none | Accepted: a hung reader holds that request's socket only; the per-IP limit bounds how many one client can hold, and `/live` no longer calls the reader. |

## Deployment schemas (row J)

Finding: keep one schema per deployment; reject a stable `--schema`.

- Ponder refuses a schema used by a different build: "Schema "…" was previously used by a different Ponder app.
  Drop the schema first, or use a different schema." (`ponder/dist/esm/database/index.js`). With a stable schema,
  every deploy that changes code would crash-loop until the schema is dropped by hand, and dropping it removes
  the index the views point at. Re-indexing a new build is not avoidable either way.
- The same build resumes in its own schema ("Detected crash recovery"), which is what the per-deployment name
  already gives a restart or a `machine update`: the schema name only changes with the image.
- The views schema `reader` is re-pointed only when the new deployment reaches ready (Ponder creates the views just
  before setting `is_ready`), so readers of the views see the previous deployment until then.

Old schemas: Ponder never drops a replaced deployment's schema. Not from record (no schema name is known here):
list them, and read which one the views point at, from an ephemeral console as above:
`select schema_name from information_schema.schemata` and
`select definition from pg_views where schemaname = 'reader' limit 1`. Every schema that is not the live one,
not `reader`, not `ponder_rpc_cache_1` and not a Postgres schema is a replaced deployment's, and is dropped with
`DROP SCHEMA "<name>" CASCADE` once the live deployment is ready. Its views in `reader` already point elsewhere, so
the drop does not touch what is served. Keep the newest replaced schema until the next deployment is live, as a
fallback. Before a drop, every `reader` view must reference only the live schema, and no view outside the
targets may reference them. `ponder_rpc_cache_1` (the RPC cache) is never dropped.

## Registration surfaces — publish procedure (GATED: not run; publishes only after /ready 200)

Publish gate (S201): "nothing publishes and no chain tx until /ready 200." Every command in this section is
**Not run — gated**. The description copy in both files is a draft for the founder's review before publishing.

The two files:

- `packages/mcp/static/agent-registration.json`: the EIP-8004 registration file (`type`
  `https://eips.ethereum.org/EIPS/eip-8004#registration-v1`; `services` entries `name` / `endpoint`;
  `registrations` entries `agentId` / `agentRegistry`), served by the front at
  `GET https://read.nablaz.io/.well-known/agent-registration.json` (EIP-8004's own path, R-S201-6; it is also the
  EIP's optional endpoint-domain verification artifact for `read.nablaz.io`). Its registry address comes from
  `packages/reader/src/generated/erc8004.json` (a unit test compares the two).
- `server.json` (repo root): the MCP Registry entry `io.nablaz/reader`, schema
  `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`, which limits `description` to
  100 characters. The description is the founder-approved 98-character string (R-S201-6 (c)).

### 1. agentURI (ERC-8004, agentId 1650)

Not run — gated. The agentURI value is `https://read.nablaz.io/.well-known/agent-registration.json`. The owner of
agentId 1650 sets it with `setAgentURI(uint256 agentId, string calldata newURI)` (EIP-8004) on the Identity
Registry on eip155:42161 (address in `packages/reader/src/generated/erc8004.json`), arguments
`1650, "https://read.nablaz.io/.well-known/agent-registration.json"`: a founder Ledger transaction from her
Mac. Before signing, `GET` the URI and confirm it serves the committed file.

### 2. MCP Registry (official)

Not run — gated. From the registry's own docs (modelcontextprotocol/registry: `docs/modelcontextprotocol-io/`
`quickstart.mdx`, `authentication.mdx`, `remote-servers.mdx`, fetched S201).

Key pair, on the founder Mac only, kept in `~/Developer/nablaz/secrets/mcp-publisher/` (outside every repository).
The Ed25519 path needs OpenSSL 3 or later; macOS's system `openssl` (LibreSSL) fails with
`Algorithm Ed25519 not found`, so call OpenSSL 3 explicitly (`/opt/homebrew/opt/openssl@3/bin/openssl` on Apple
Silicon, after `brew install openssl@3`):

```bash
# Not run — gated
mkdir -p ~/Developer/nablaz/secrets/mcp-publisher && cd ~/Developer/nablaz/secrets/mcp-publisher
MY_DOMAIN="nablaz.io"

# Generate public/private key pair using Ed25519
openssl genpkey -algorithm Ed25519 -out key.pem

# Generate TXT record
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "${MY_DOMAIN}. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
chmod 600 key.pem
```

DNS: add the TXT record `v=MCPv1; k=ed25519; p=<PUBLIC_KEY>` at the **apex** of `nablaz.io` in GoDaddy (the
address bar must show nablaz.io before any DNS edit). Not under a selector such as `_mcp-auth.nablaz.io`: the
registry looks at the apex only. Check it has propagated:

```bash
# Not run — gated
dig TXT nablaz.io +short
```

Install `mcp-publisher` (one release binary; `brew install mcp-publisher` also works):

```bash
# Not run — gated
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

Log in (R-S201-6 (b), amended): the key is passed to `--private-key` by command substitution from `key.pem`, so it
never renders in the terminal or the shell history. One `&&` chain, in a plain terminal, with OpenSSL 3 as `openssl`
(see the LibreSSL note above):

```bash
# Not run — gated
cd ~/Developer/nablaz/secrets/mcp-publisher && mcp-publisher login dns --domain nablaz.io --private-key "$(openssl pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
```

The substitution emits the Ed25519 seed as 64 hex characters, the shape `mcp-publisher` 1.8.7 asks for
(`-private-key <64 hex chars>`): checked S201 on a throwaway key with OpenSSL 3.0.16, where the public key derived
from the emitted seed equaled `openssl pkey -pubout`'s. The TXT derivation (`openssl pkey -pubout -outform DER | tail -c 32 | base64`) was checked S201 on a separate
throwaway key the same way: it emitted 44 base64 characters ending in `=`, which decode to the key's 32 public-key
bytes. Residual disclosure: the expanded key exists briefly in the
login process's argument list on the founder Mac; accepted for a single-use login. A vault-held key
(`mcp-publisher login dns google-kms` or `azure-key-vault`, in the registry docs) avoids that, at the cost of a
cloud KMS account.

After login, validate and publish from the repository root:

```bash
# Not run — gated
mcp-publisher validate
mcp-publisher publish
```

Verify through the registry API:

```bash
# Not run — gated
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.nablaz/reader"
```

The registry does not check that the remote URL is on the authenticated domain, and each remote URL can be used by
one server name only. If keys are rotated, remove the old TXT record from the apex.

### 3. Secondary directories

Not run — gated. Only after the official listing above is live.

### Note: endpoint-domain verification

EIP-8004's optional endpoint-domain verification uses `https://{endpoint-domain}/.well-known/agent-registration.json`,
the path the front serves. For `read.nablaz.io` it is the same file the agentURI names. It would also apply to
`nablaz.io` (the `web` service endpoint), which this repository does not serve.
