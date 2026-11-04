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
RPC cache (schema `ponder_sync`) is shared, so a redeploy reindexes from the cache rather than from the RPCs. Ponder does not drop the schema of a deployment
that has been replaced; replaced schemas are dropped by hand once the new deployment is live.

## Health: /live and /ready

- `GET /live` is deploy health, and Fly's check (`fly.toml`, 60 s grace). It answers 200 when the front is up
  and the reader process runs, whatever the index progress; 503 otherwise. `scripts/reader-start.sh` passes the
  reader's PID as `NABLAZ_READER_PID`, so the front checks the process (`kill(pid, 0)`) and never calls into
  Ponder's event loop: a long block in Ponder does not fail Fly's check (R-S194-15). Without the PID, `/live`
  asks the reader's `/health`.
- `GET /ready` is index readiness, the public signal: 503 until the index has caught up, 200 after. `/ready`
  503 during backfill is expected, not an incident.

## Database backup (off-platform)

`pg_dump` runs daily from a host outside Fly, over the database's external connection string, held only in
that host's environment as `NABLAZ_READ_DATABASE_URL`. Fourteen dumps are kept. The `pg_dump` major version
must be at least the server's.

```cron
# m h dom mon dow   daily at 03:15 UTC
15 3 * * *  pg_dump --format=custom --no-owner --no-privileges --dbname="$NABLAZ_READ_DATABASE_URL" --file="$BACKUP_DIR/nablaz-read-$(date -u +\%Y\%m\%dT\%H\%MZ).dump" && find "$BACKUP_DIR" -name 'nablaz-read-*.dump' -mtime +14 -delete
```

Restore into an empty database with `pg_restore --no-owner --dbname="$TARGET_DATABASE_URL" <dump>`; it holds
`ponder_sync` and every deployment schema present when the dump was taken.

## Start-up RPC check, leg tags and RPC counters

- Before Ponder starts, `scripts/reader-start.sh` runs `packages/reader/scripts/check-rpc.ts`: each of the four
  RPC variables must answer `eth_chainId` with its chain's id, and `eth_blockNumber`. It tries up to 3 rounds, 5 s
  apart, and logs one line per leg, by variable, chain, role and host (never the path or key). A leg that still
  fails stops the start with exit 1, naming the leg: `rpc check FAILED: READER_..._URL (<chain> <role>, host
  <host>): <reason>`. Fly then restarts the machine (see Restart policy).
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
the reader runs). Not from record, not yet run: from an ephemeral console as above, with `x.sh` holding
`cd /app/packages/reader && node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/c-share.ts <chainId> <fromBlock> <toBlock>`.
For a vault payment's label it reads the chain's RPC (`READER_ARBITRUM_RPC_URL`), present on the console machine.

### Logs

`~/.fly/bin/flyctl logs -a nablaz-reader --no-tail` returns the last 100 lines only (S200: 100 lines, about 18 s,
both reads). It cannot reach an earlier day. Mask URLs before printing any line.

### Restart policy and exit 75 (S196–S197 record)

"restart-policy behavior row (exit 75 → flyd loop → autostart on next request)". Observed: "reader crash-looped
exit 75 from ~12:32Z Oct 30 under flyd policy"; "pipeline frozen on BOTH chains after two exit-75 restarts
20:46:49Z/21:01:00Z Oct 30; restart unfroze" (one restart by ruling 15:12:29Z Oct 31 unfroze it).

Not from record: exit 75 is Ponder's own exit code; from inside the image it does not say which failure caused
it. The start-up RPC check above exits 1, so a leg that fails at boot is told apart from it. A restart after a
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
| Fly restart policy | not set in `fly.toml` | Accepted with the record above (exit 75 → flyd loop); the RPC check exits 1 to tell its failures apart. |
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
not `reader`, not `ponder_sync` and not a Postgres schema is a replaced deployment's, and is dropped with
`DROP SCHEMA "<name>" CASCADE` once the live deployment is ready. Its views in `reader` already point elsewhere, so
the drop does not touch what is served. Keep the newest replaced schema until the next deployment is live, as a
fallback. `ponder_sync` (the RPC cache) is never dropped.
