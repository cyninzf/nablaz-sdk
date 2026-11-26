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
| `READER_POLYGON_RPC_URL` | Chainstack, chain 137 (R-S221-8: DelegationManager only). Founder-created Polygon node; must be set before the bundle deploy, or `scripts/reader-start.sh` refuses to start |
| `READER_POLYGON_GROUNDING_RPC_URL` | Alchemy, chain 137: the Hosted Reader app with Polygon enabled (same key as the other grounding legs) |
| `READER_OPTIMISM_RPC_URL` | Chainstack, chain 10 (S230: SpendPermissionManager and DelegationManager). Must be set before the join deploy, or `scripts/reader-start.sh` refuses to start |
| `READER_OPTIMISM_GROUNDING_RPC_URL` | Alchemy, chain 10: the Hosted Reader app with OP Mainnet enabled (same key as the other grounding legs) |
| `READER_LINEA_RPC_URL` | Chainstack, chain 59144 (S230: DelegationManager only). Must be set before the join deploy, or `scripts/reader-start.sh` refuses to start |
| `READER_LINEA_GROUNDING_RPC_URL` | Alchemy, chain 59144: the Hosted Reader app with Linea enabled (same key as the other grounding legs) |
| `MCP_CLIENT_IP_HEADER` | `Fly-Client-IP`, the client-IP header Fly's edge sets |
| `DATABASE_URL` | set by `fly mpg attach nablaz-reader-db -a nablaz-reader`, not in `fly.toml` |
| `MCP_RATE_LIMIT_PER_MIN` | optional, default 60 |
| `NABLAZ_FEED` | `on` since 2026-11-15 (S221), set as machine env by `flyctl machine update --env` (below). Unset, GET /feed is off; never a default in code or `fly.toml` |
| `NABLAZ_TX` | `on` since 2026-11-24 (S228), set as machine env by `flyctl machine update --env` in the carry-all form (every existing machine env passed explicitly, verified after). Both flip gates held first (R-S226-4): (1) the EXPLAIN on its `*_tx` indexes passed on 42161, 8453 and 137 (`scripts/explain.mjs`, step 5); (2) the per-IP bound on the door's RPC path, which spends one `eth_getTransactionByHash` per miss, is the front's shared window, 60 per IP per minute (`DEFAULT_RATE_LIMIT_PER_MIN`, keyed by `Fly-Client-IP`; ruled no change at S228 until tx-door 429s or outside-read traffic say otherwise). Unset or anything but `on`, the door answers 503 `{"ready":false}`; never a default in code or `fly.toml` |

The first eleven are Fly secrets. `PORT` is pinned to 3042 in `fly.toml`, equal to `internal_port`.
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
- Resume deploy, 2026-11-26 (S232, release 21, `READER_SCHEMA` = the live schema, build id fe32cfae51, 32 indexes):
  40m45s of public `/ready` 503, 17:16:42Z to first 200 at 17:57:27Z (30 s poll). Deploy 17:15:41Z to 17:17:25Z;
  `Detected crash recovery` 17:17:24Z, `Created database indexes count=32 (30m 55s)` 17:48:20Z, views 17:48:20Z, then
  9m07s to `/ready` 200 (head gate). Compare S228's 42m42s below.
- Same image, same schema (a `machine update` or restart, Ponder replays from its own schema): crash recovery, so the
  same index rebuild as a resume. Latest, and the figure to plan against: 2026-11-24 (S228, the `NABLAZ_TX=on` flip,
  32 indexes): 42m42s of `/ready` 503, `machine update` 17:47:47Z to first public `/ready` 200 at 18:30:29Z (polled
  every 15 s; `/live` 200 throughout); the rebuild/head-gate split was not captured (the log lines had rotated out
  before they were read). It supersedes the 29m16s below. Earlier: 2026-11-15 (S221, the `NABLAZ_FEED=on` flip, 24 indexes): 29m16s of
  `/ready` 503, `machine update` 20:54:02Z to first public `/ready` 200 at 21:23:18Z; `Created database indexes
  count=24 (22m 25s)` at 21:16:38Z, views 21:16:40Z, then 6m38s to `/ready` 200 (head gate). The earlier ~13 min
  (2026-11-04, 16:05:24Z to 16:18:15Z) was with 20 indexes.
- Resume deploy (new image, `READER_SCHEMA` = the live schema): no constant is carried (R-S221-6). A resume is not a
  quick restart: Ponder's crash recovery drops and rebuilds every user index of the schema (below), and the window
  grows with row count. Measured points, 24 indexes: S217 (2026-11-13, resume): ~22 min, a 16-min index rebuild
  (the four `*_feed` on ~3.06M and ~1.81M rows included) then ~6 min of head-gate catch-up (inferred); S221
  (2026-11-15, same-image `machine update`, the same crash recovery): 29m16s to public `/ready` 200, rebuild 22m25s;
  S222 (2026-11-17, the pinned deploy, sdk #32, earlier the same day as the reindex deploy): 33m20s to public
  `/ready` 200. Before the schema event (20 indexes): ~13 min,
  three times (2026-11-04, and two resumes on 2026-11-10).
- Per-chain finality is read from the `Indexed` lines of the reader's log (`Indexed block chain=<name>
  number=<block>`), one chain per line.
- New image, new schema (a full index from the RPC cache): no duration is carried (R-S208-1). It is computed at
  dispatch, per chain, from that chain's head gap (blocks) × its observed indexing time per block; `/ready` flips
  at the maximum across chains. It is bound by the indexing handlers, not by the RPCs. A chain with no cache is
  sized differently (R-S222-8, "Never-indexed chain" below).

Measured points by KIND (each kind is its own series; a point never stands in for another kind's):

| Kind | When | Window | Notes |
| --- | --- | --- | --- |
| Resume / same-schema rebuild | S217 2026-11-13 | ~22 min | 24 indexes; catch-up inferred |
| Resume / same-schema rebuild | S221 2026-11-15 | 29m16s | `machine update` flip; rebuild 22m25s |
| Resume / same-schema rebuild | S222 2026-11-17 | 33m20s | the pinned deploy (sdk #32), earlier the same day as the reindex deploy |
| Resume / same-schema rebuild | S228 2026-11-24 | 42m42s | `machine update` flip (`NABLAZ_TX=on`), 32 indexes; 17:47:47Z → first public `/ready` 200 18:30:29Z, 15 s polling; rebuild split not captured. Supersedes S221's 29m16s as the figure to plan against |
| FULL REINDEX (new schema) | 2026-11-17 → 2026-11-19 | 41h33m39s (−60s) | deploy 20:25:49Z Nov 17 → first public `/ready` 200 13:59:28Z Nov 19; three chains (42161, 137, 8453); Polygon 0% RPC cache; external_payments ~4.93M rows, external_permissions ~2.89M |

Method note (full reindex): the deploy's own logs rotated out long before the end, and two Codespace losses cut the
local capture, so the READY edge is read from the Sentry uptime monitor on `/ready` (monitor 10912822: the first
check that answered 200), a server-side record that survives both. Its 60 s check interval is the −60s: the true
edge lies up to 60 s before the recorded one.

### Resuming a schema (R-S202-4, S202)

When the new image computes the same Ponder build id as a deployment whose schema exists, the deploy can resume
that schema instead of indexing a new one. Ponder 0.18.1 derives the build id at `build/index.ts:567` from three
hashes (checked against 0.18.6 for R-S212-4: `build/index.ts` is byte-identical in the two versions, with
`BUILD_ID_VERSION = "2"`, and the `_ponder_meta` version is `"6"` in both, so the upgrade alone keeps the id): the evaluated config (`ordering`, `contracts`, `accounts`, `blocks`: addresses, ABIs, filters and start
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

`scripts/reader-start.sh` then starts Ponder on `<schema>` instead of the image tag. A resume deploy still drops and
rebuilds ALL user indexes of the schema: S217 ~22 min, S221 29m16s to public 200 (rebuild 22m25s), growing with row count
(Timings on record). It keeps the rows, not the
indexes. Ponder rolls the tables back to the safe checkpoint (it drops the schema's indexes and reverts rows
written after it, with `is_ready` back to 0), re-indexes the gap to the head, rebuilds the indexes, re-points the
`reader` views and sets `is_ready`; `/read` answers 503 `{"ready":false}` until then (below). A mismatched build id crash-loops at start ("Schema … was
previously used by a different Ponder app") and nothing is dropped: redeploy without the override, which indexes
into the new image's own schema.

Computing the id (S206): `packages/reader/scripts/bid.mjs <rev>...` (usage in its header) reproduces Ponder's id at
any revision. Two findings it encodes:

- The id hashes the FILE SET of `src/` (outside `src/api/` and tests), not only file contents: moving a file out of
  `src/` moves the id exactly as editing it does. Relocating `src/c-share.ts` and `src/wording.ts` to `lib/`
  (R-S206-3) moved it from `77bb04f918` to `a1cb6b1278`; no destination for a counted file keeps the id.
- The S202 version of the method (kept only in a session transcript) took the file list from the working tree and
  each revision's contents into it, which is wrong for any revision with a different file set. The committed
  script extracts each revision with `git archive` and globs it as Ponder does.

Recorded ids (`_ponder_meta`, `key = 'app'`, read S206):

- `deployment-01m6p05twt15f0pb31gr64t2p3` (live until the R-S206-3 reindex): `77bb04f918`, indexed by `4088e055`
  (S203 deploy).
- `deployment-01m6kzw3gbywjjj45zej11n81k` (fallback): `f5d3ef1e89`, indexed by `ea1461ce` (S201 deploy).

### Schema event deploy (R-S214-5, R-S213-6)

The schema event (`reader: schema event — feed indexes, AFG mint-block skip, Base comment, runbook`)
adds the feed index `(block_timestamp, chain_id, block_number, log_index)` (R-S215-4: ascending, read backward by
GET /feed's descending ORDER BY) as `record_entries_feed`, `external_permissions_feed`, `vault_payments_feed` and
`external_payments_feed` (GET /feed's tables, S213-L1). It changes `ponder.schema.ts` and
`src/grounding-rpc.ts`, so the build id moves off `a1cb6b1278` (the PR records the new id, computed with
`scripts/bid.mjs`): it cannot resume the live schema, and it is a full reindex into the new image's own schema.
It deploys only on the CTO's timing word (R-S215-6: at the start of a fresh session, on the founder's word), never with a merge.

1. Budget: a full reindex, ~10M RPC calls (R-S214-5), all behind the 503 gate: `/ready`, `/read`, `/feed` and the
   MCP tool answer 503 `{"ready":false}` until the new schema is ready. The duration is computed at dispatch as
   under Deploys, not carried. The Sentry `/ready` monitor fires during the window: expected.
2. Logs for the ENTIRE window (S213-L7, R-S221-6): start `node scripts/fly-log-poll.mjs <dir>` in the background
   (`<dir>` outside `/tmp`, e.g. `~/captures/<session>`) BEFORE the deploy command, and stop it only after step 4.
   It polls `flyctl logs --no-tail` every 5 s and appends each new line, deduplicated by the full line: URL-masked
   lines to `<dir>/log.txt`, the front's caller lines unmasked to `<dir>/caller.log`. Not a streaming
   `flyctl logs`: in S221 the stream stalled silently (alive, no lines, while `--no-tail` showed new ones). A single
   `--no-tail` is not enough either: 100 lines, about 10 s while Ponder indexes, and the S213-SE9 ready line had
   rotated out before `/ready` went public; the 5 s poll keeps about 2x margin. Mask URLs before printing any line.
3. Deploy WITHOUT the `READER_SCHEMA` override (the plain command under Deploys). The override is for an
   unchanged build id only; with this image it crash-loops ("previously used by a different Ponder app").
4. Ponder-ready timestamp, from the stream, in order (Ponder 0.18.6 `runtime/multichain.js`): `Completed backfill
   indexing across all chains`; `Created database indexes` with `count` 24 (20 before this event, plus the four
   `*_feed`); R-S226-4 schema event: `count` 32 (26 declared at 611fbc7, after the G1 bundle, plus the six `*_tx`);
   `Created database views` (schema `reader`), immediately before `is_ready` is set. Record the
   timestamp of each, then the first public `/ready` 200 (the head gate, B1, may hold it a little after).
5. S213-L1 on production rows, before any flip: from an ephemeral console (above), plain `EXPLAIN` of each of the
   four GET /feed queries (`src/api/index.ts`, `/feed`) in the new schema: `node scripts/explain.mjs` from the repo
   root (it runs itself in a throwaway console, prints the four plans with row estimates, then fails unless exactly
   ONE machine remains). The gate, in the R-S217-1 form: every table of a million rows or more must be read through
   its `*_feed` index, and that is a PASS; a `Seq Scan` on a table that fits in about one feed page (S224:
   `record_entries` ~4 rows, `vault_payments` ~1) is the planner's cost choice, reported, not a stop. A multi-megarow
   table off its `*_feed` index stops the flip and is reported. ~~Any `Seq Scan` stops the flip~~: superseded by
   R-S217-1. The PR records the synthetic-row plans this gate repeats. Since R-S226-4 the same run also plans the
   any-hash door's lookup on its six tables (`chain_id = N and tx_hash = H`), under the same rule against each
   `*_tx` index; `NABLAZ_TX` stays off on any FAIL. Since S233 it also plans each feed table's window-by-position query
   (GET /feed?at=…, the cursor query bounded at 2026-06-30T23:59:59Z), under the `*_feed` rule. Plans of record, S224 (2026-11-19 18:11Z,
   live schema `deployment-01m7njzvx0jw0bxzvwh0zqmpp3`): `external_payments` ~4,931,362 rows and
   `external_permissions` ~2,891,871 rows, each `Index Scan Backward using <table>_feed`; verdict PASS.
6. Deploy-day flag flip, only after step 5 passes and on the word: `NABLAZ_FEED=on`, exactly `on` (the reader and
   the front both test `=== "on"`; `true` or `1` leaves /feed off), as machine env, never `fly deploy` (no new
   schema) and not a Fly secret. The form that ran on 2026-11-15 (S221):
   `~/.fly/bin/flyctl machine update 850dd3a4113e78 -a nablaz-reader --env NABLAZ_FEED=on --yes < /dev/null`.
   Read `flyctl machine status -d` before and after: the only change is `NABLAZ_FEED`, and `READER_SCHEMA`, the
   image and the VM size are unchanged. The update restarts the machine on the same image and schema: crash
   recovery rebuilds every index, 42m42s of `/ready` 503 at S228 (32 indexes; Timings on record), so capture logs through it as in
   step 2. Off again (not yet run): flyctl 0.5.7's `machine update` has no flag to unset an env var, so
   `--env NABLAZ_FEED=off` in the same form; any value other than `on` is off, and it costs the same restart.
   (Observed on flyctl 0.5.7; re-check `machine update --help` on the installed version before relying on it.)
6a. Full-reindex deploy with the feed already on (R-S222-7): `NABLAZ_FEED` is machine env and CARRIES through a
   `fly deploy` (read S224: after the Nov 17 full-reindex deploy the machine's env still holds `NABLAZ_FEED=on`), so the new schema serves
   /feed the moment it is ready, with no flip step. Therefore:
   1. EXPLAIN (step 5) is the FIRST post-ready check, before any other read of the new schema is reported.
   2. Its fallback is stated BEFORE the deploy: if EXPLAIN fails, turn the feed off with the step-6 off form
      (`machine update … --env NABLAZ_FEED=off`, a same-schema restart, Timings on record), then report.
   3. Machine env that a deploy is meant NOT to carry is named in the deploy order: in particular a deliberate drop
      of `READER_SCHEMA` (a resume override that must not survive into a full reindex) is written as its own line,
      never left implied.
7. Afterwards: the replaced schema is kept as the fallback and dropped only under R-S208-1's two gates.

### Never-indexed chain (R-S222-8)

A chain the RPC cache has never held (Polygon at the Nov 17 reindex: 0% cache) indexes from its providers, not from
`ponder_rpc_cache_1`. Its window is sized by SPEND, not time: the providers' own caps bound it, and no duration is
promised. Exactly two stop conditions, and no others (R-S222-8):

1. The reader's startup fails closed ("reader-start fails closed").
2. A provider cap fires ("provider cap fires"), instrumented by the 402/429 detector (`scripts/rpc-limit-detector.mjs`
   over the captured log, "Spend/limit detector" below).

There is no separate manual spend-budget condition: the provider caps ARE the spend bound ("provider caps fail loudly
by construction"). There is no time-based abort; slowness alone is not a stop.

### VM memory: fly.toml is the source (R-S222-9)

`fly.toml` `[[vm]] memory` outranked `flyctl deploy --vm-memory`: the 2026-11-17 20:25:49Z full-reindex deploy
(flyctl 0.5.7) came up on `fly.toml`'s `2gb` although the flag asked for 4096; it was corrected by
`fly machine update` to 4096 at 20:28:40Z, about three minutes into backfill. Since S224 `fly.toml` says `memory = "4gb"`, the size
the machine runs. `fly.toml` is not a build-id input (the id hashes only `packages/reader`'s `src/` outside `src/api/`,
`ponder.schema.ts` and the evaluated `ponder.config.ts`; `packages/reader/scripts/bid.mjs`), so this keeps the id.
After every deploy, verify the guest block:

1. `~/.fly/bin/flyctl machines list -a nablaz-reader --json`: exactly one machine.
2. Its `config.guest`: `cpu_kind` `performance`, `cpus` 1, `memory_mb` 4096.
3. Its `config.env`: `NABLAZ_FEED` as ordered, `READER_SCHEMA` present or absent as ordered (R-S222-7).
4. Any mismatch: stop and report before the next step; do not correct it in the same pass.

Version note: the precedence was observed on flyctl 0.5.7; this Codespace has 0.5.13 (S224). The precedence is
flyctl behavior and may change between versions, so the verify above, not the version, is what proves the size.

### Spend/limit detector (standing form, S224)

`scripts/rpc-limit-detector.mjs <log.txt>` flags a line ONLY when a 402 or 429 is written as a status:
`status=402|429`, `HTTP 402|429`, or `code 402|429` (`code=`/`code:` too). A bare 402 or 429 elsewhere (block
numbers, hashes, durations, JSON-RPC codes such as -32005) is not a hit. Its red fixtures (lines that must flag) and
green fixtures (lines that must not) run in CI (`--self-test`); a change to the pattern changes the fixtures in the
same commit.

### Non-terminal-resident check (S224; the watcher-loss class, sixth occurrence)

Six captures or watchers have been lost with the terminal or machine that held them, two of them Codespace
deletions within 24 h (Nov 18–19). The rule: nothing load-bearing lives in a terminal or a home directory.

- Load-bearing records are server-side or scheduled: the READY edge is the Sentry uptime monitor on `/ready`
  (60 s, monitor 10912822); counters are `/metrics/reader`, scraped at both ends of a window; the plans of record
  are in the PR that ran them.
- The log/UA capture (`scripts/fly-log-poll.mjs`) and the `/ready` watch (`scripts/ready-watch.mjs`) are committed
  scripts, so a lost Codespace costs a restage, not a rebuild. They remain conveniences: a window that a loss
  interrupts is a gap, stated with its bounds, never stitched.
- Open design row: a server-side log sink (a Fly log-shipper app forwarding `nablaz-reader`'s logs to a durable
  store) would make the UA capture itself non-resident. Until it exists, the UA config (`caller-ua.json`) is
  populated only from a stated, uninterrupted multi-day window (R-S221-1).

### Cold reboot (S224, from two rebuilds in 24 h)

A deleted and recreated Codespace keeps the repository's committed files and the repository secrets (re-injected at
creation, `FLY_API_TOKEN` among them, checked by name only), and loses everything else. One command restores it:

```bash
cd /workspaces/nablaz-sdk && scripts/arm.sh /workspaces/captures/<session>
```

1. User-level attribution: `~/.claude/settings.json` `"attribution": {"commit": "", "pr": ""}`, and `.claude/` in
   `.git/info/exclude`: both lost; `arm.sh` restores them.
2. Repository secrets: re-injected automatically; `arm.sh` lists the `READER_*` names and checks `FLY_API_TOKEN`.
   The Codespace carries some of the ten reader names only; `bid.mjs` needs all ten set, placeholders fine (its header).
3. Fly auth state: lost with the home directory; flyctl authenticates from `FLY_API_TOKEN`, and `arm.sh` installs
   flyctl if missing and checks `flyctl auth whoami`.
4. Pollers and staged scripts: lost; `arm.sh` re-arms the log/UA poller and the `/ready` watch from the committed
   scripts and prints their output paths. `node scripts/explain.mjs` replaces any staged EXPLAIN kit.

## Health: /live and /ready

- `GET /live` is deploy health, and Fly's check (`fly.toml`, 60 s grace). It answers 200 when the front is up
  and the reader process runs, whatever the index progress; 503 otherwise. `scripts/reader-start.sh` passes the
  reader's PID as `NABLAZ_READER_PID`, so the front checks the process (`kill(pid, 0)`) and never calls into
  Ponder's event loop: a long block in Ponder does not fail Fly's check (R-S194-15). Without the PID, `/live`
  asks the reader's `/health`.
- `GET /ready` is index readiness, the public signal: 503 until the index has caught up, 200 after. Since S213
  (B1) the front relays the reader's `GET /ready/head` (`packages/reader/src/api/head.ts`): 200 only when Ponder's
  own `/ready` is 200 AND each chain's indexed block is within 15 s of chain time of the omnichain frontier, the
  minimum of the chains' head timestamps (R-S232-2; head-advance grace 12 s, R-S232-6; a head older than 300 s is
  never current). The heads are read with `eth_getBlockByNumber("latest")` on the indexer transport, cached per chain and refreshed at most every
  10 s, never per request. It closes the S211 row where `/ready` turned 200 about 4.5 min before the index reached
  the chain head. The not-ready answer is unchanged: 503 `{"ready":false}`. `/ready`
  503 during backfill is expected, not an incident.
- S232 figures (2026-11-26). Under the S213 per-chain rule, release 20 flapped: 34/119 loopback and 13/48 public
  `/ready` samples were 503 (~28%), because omnichain ordering holds every chain at Linea's last block and Linea's
  gaps reach 36 s. Release 21 (frontier gate, R-S232-2) cut it to 2/119 loopback (~2%). Its 30-min public watch
  (60 s samples, 17:57:12Z to 18:27:12Z) had 1/31 non-200, and the 30 s edge log showed four 503 windows of 30-60 s:
  18:01:27, 18:20:30, 18:25:00 and 18:27:12Z. The residual was a Linea race. After a Linea gap over 15 s, the 10 s
  head cache saw the new block before Ponder's 2 s poll indexed it, so the lag read as the whole gap; R-S232-6's
  head-advance grace closes that race.
- A Sentry uptime monitor watches `https://read.nablaz.io/ready` every 60 s and fires after 3 failures, so every
  deploy with a 503 window (a resume included) raises an expected alert.
- The `/ready` body (S204): `/ready` answers HTTP 200 with an EMPTY body when ready (the front's `relay()` passes
  Ponder's answer through below 500); `{"ready":false}` exists only on the 503 branch; nothing in the code serves
  `{"ready":true}`. Readiness is the status code.

## /read

- Readiness gate (R-S202-4): `GET /read/:chainId/:address` and the MCP `read_subject` tool answer 503
  `{"ready":false}` (the tool: an error result carrying `{"ready":false}`), and read nothing, whenever the index is
  not ready, in the same vocabulary as `/ready` (R-S193-13). Both doors use one check in the front
  (`readerReadiness`, `packages/mcp/src/server.ts`): the reader's `/ready/head` (above; before S213, its own `/ready`), which Ponder answers from the
  running app's `is_ready`. An empty record from an unready schema is absence, not a record (R-S189-6). Evidence:
  the S202 public probe at 15:48Z, on an image whose `/ready` was 503, returned `facts: []` with
  `asOfBlock` 445102197 in 66 to 71 s, and an intermittent 500.
- Any-hash door (R-S219-6, R-S226-4): `GET /read/:chainId/tx/:txHash` resolves a transaction hash to the facts it
  anchors in `record_entries`, `vault_payments`, `external_permissions` (a permission's first log),
  `external_payments`, `external_redemptions` and `credit_line_events`, built by the subject page's own fact builders
  (`packages/reader/src/api/tx.ts`), so each fact's source, label, citation and one-liner are the subject page's.
  ERC-8004 feedback grounding is read on the subject page only. OFF unless `NABLAZ_TX` is exactly `on`, in the
  reader and the front alike: off, the front routes it and answers 503 `{"ready":false}` at once, asking no reader,
  and the reader issues no statement. On, it is gated as `/read` (R-S202-4). It stays off until the next schema
  event ships a `tx_hash` index on each of those six tables: without one every lookup is a sequential scan, and
  `external_payments` (~4.9M rows) and `external_permissions` (~2.9M) are over the R-S217-1 million-row bar.
  A hash the record does not hold is a 404 whose body says why (S222), in `reason`: `not-indexed` (the chain has
  it above the indexed block, or pending), `no-fact` (at or below the indexed block, anchoring no fact here),
  `unknown-hash` (the chain has no such transaction) or `not-determinable` (that chain lookup, one
  `eth_getTransactionByHash` on the indexer leg, failed). An unread chain answers `/read`'s own
  `{"error":"chain N is not read here"}`.
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

### Post-incident rider (S211)

After any reader incident, two checks before the incident is closed.

TEST-account read, against the baseline pinned in `packages/reader/test/fixtures/test-account-baseline.json`
(its five facts by source, block, logIndex and tx, and the two live check 2 txs). From the repo root:

```
curl -s -H 'x-nablaz-caller: fixture' https://read.nablaz.io/read/42161/0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c > /tmp/test-read.json
cd packages/reader && BASELINE_READ=/tmp/test-read.json npx vitest run --project unit test/unit/test-account-baseline.test.ts
```

The `x-nablaz-caller` header marks the read as ours for the outside-read instrument (P-GTM-4, below). This form
sends `fixture`. A CTO probe sends `cto`, an SE probe `se`, and a probe or watcher script `watcher`. With node
fetch, as in the Codespace: `fetch(url, { headers: { "x-nablaz-caller": "se" } })`.

The test passes only when the read's facts equal the baseline exactly. Without `BASELINE_READ` that case reads the
committed capture `packages/reader/test/fixtures/test-account-read.json` (S213 A3), so it runs in every `pnpm test`
and never skips.

Resume-deploy form, to redeploy without a full reindex:

```
~/.fly/bin/flyctl deploy -a nablaz-reader --ha=false --env READER_SCHEMA=<live schema> < /dev/null
```

This form is legitimate only when `bid.mjs` at the commit being deployed equals the live schema's build id
(`_ponder_meta`, `key = 'app'`, `build_id`). Recompute both at deploy time, never from a carried figure. A plain
deploy without `READER_SCHEMA` still indexes into the new image's own schema, a full reindex behind the 503 gate,
whatever the build id.

A resume is not free: a resume deploy still drops and rebuilds every user index of the schema, once Ponder has
caught up, behind the 503 gate. Measured points, never a constant (R-S221-6): S217 ~22 min (16-min rebuild of 24
indexes plus ~6 min of head-gate catch-up, the catch-up inferred); S221 29m16s to public 200 (rebuild 22m25s); the
window grows with row count. Before the schema event (20 indexes), measured on Nov 10 2026 (S211 resume of `dfbc509e`, 102MB `maintenance_work_mem`
and 2 parallel maintenance workers, the server's settings then): `/ready` answered 503 for 13m33s, of which
`Created database indexes count=20` took 13m26s. With the session settings below (32MB, no workers) the rebuild
was measured once (S212): the Nov 10 resume deploy rebuilt 20 indexes in 13m08s with database memory flat at
570–585 MB. Demonstrated once, not yet proven permanent.

### Session memory settings (R-S212-4)

On Postgres, every connection the reader's Ponder opens sets `maintenance_work_mem=32MB`,
`max_parallel_maintenance_workers=0` and `work_mem=16MB` for its own session: the startup parameter
`database.poolConfig.options` in `packages/reader/ponder.config.ts`, which Ponder passes to all four of its pools.
The cluster's configuration is untouched (R-S204-2). They exist for the index rebuild, where the 1 GB database ran
out of memory in S211; whether they stop that is unproven until the database memory graph is watched during a
rebuild. Notes:

- A startup parameter needs the direct host, as `DATABASE_URL` is; a PgBouncer pool refuses it (S194).
- Ponder's readonly pool (the API's `/read` and `/feed` queries) runs `SET work_mem = '512MB'` after connecting,
  which overrode the `work_mem` here for that pool. Since S213 (B3) `patches/ponder@0.18.6.patch` (pnpm
  `patchedDependencies`) sets it to `16MB`, so all four pools use 16MB. The patch is pinned to ponder 0.18.6 and
  must be re-proven on any Ponder upgrade; `test/unit/pg-session.test.ts` fails on any other version.
- The database config is not part of the build id (above), so changing these settings keeps it.
- Check on a session: `select current_setting('maintenance_work_mem')` from a connection opened with the same
  `options` reads `32MB` (read on the direct host, Nov 10 2026).

## Start-up RPC check, leg tags and RPC counters

- Before Ponder starts, `scripts/reader-start.sh` runs `packages/reader/scripts/check-rpc.ts`: each of the four
  RPC variables must answer `eth_chainId` with its chain's id, and `eth_blockNumber`. It tries up to 3 rounds, 5 s
  apart, and logs one line per leg, by variable, chain, role and host (never the path or key). A leg that still
  fails is named in a warning, `rpc check FAILED: READER_..._URL (<chain> <role>, host <host>): <reason>` then
  `rpc check WARNING: <n> of 4 legs failed: <variables>; starting anyway`, and the start goes on (CTO ruling,
  S200: a boot-blocking check would restart-loop on any vendor outage, the Oct 30 exit-75 class). An ongoing leg
  failure shows in `/metrics/reader`.
- Exception (R-S211-1, amends R-S200-2 narrowly): a leg that still answers HTTP 401 or 403 after the last round
  fails the start. The check prints `rpc check FATAL (R-S211-1): <n> leg(s) refused authentication: <variable>
  (<chain> <role>, host <host>): HTTP <status>; …` and exits 78, so `set -e` ends `scripts/reader-start.sh`
  (`packages/reader/lib/rpc-auth.ts`). An unauthenticated leg can never heal by waiting. Each failed start takes
  roughly 10–20 s (3 rounds, 5 s apart; inferred, not yet observed on Fly), so 10 of them fit in Fly's 5-minute
  window (on-failure, max_retries 10) and the machine stops; Fly Proxy starts it again on the
  next request (`auto_start_machines = true`), and the start fails again until the key is fixed.
- Database loss (S211): `packages/reader/src/api/db-watchdog.ts` reads Ponder's own heartbeat
  (`_ponder_meta`, `key = 'app'`, `heartbeat_at`, written every 10 s) every 15 s. When the newest heartbeat seen
  is older than 120 s (a read that fails, hangs or returns an old value), it logs `db watchdog FATAL: …` and the
  reader exits 75, so the machine restarts instead of staying up and idle. Postgres only.
- Every RPC error the reader logs starts `[rpc <chain> <leg>]`, leg `indexer` (Chainstack) or `grounding`
  (Alchemy) (R-S194-10). URLs inside the error are already `[redacted:indexer]` / `[redacted:grounding]` (R-S197-8).
- `GET /metrics/reader` on the reader's loopback port (127.0.0.1:42069, beside Ponder's own `/metrics`) serves
  per chain and leg `nablaz_rpc_requests_total`, `nablaz_rpc_errors_total`, `nablaz_rpc_rate_limited_total`,
  `nablaz_rpc_rate_limited_recent` (1 for 60 s after a 429), `nablaz_rpc_last_error_timestamp_seconds` and
  `nablaz_rpc_last_rate_limited_timestamp_seconds`. Counters start at 0 on each start. The front never relays it.
- Outside-read instrument (P-GTM-4, R-S214-11, R-S217-7, R-S221-5). Every request at the four read doors,
  GET /read, GET /feed (since R-S221-5: public since the S221 flip), GET /read/:chainId/tx/:txHash (door `tx`,
  R-S226-4, the same pattern) and /mcp, gets a caller class in the front (`packages/mcp/src/caller.ts`), at request time, from its headers:
  1. `x-nablaz-caller` when the value is exactly one of `fixture`, `ci`, `watcher`, `cto`, `site` or `se`; any
     other value is ignored.
  2. Otherwise `ingester` when the user-agent contains a pattern in `packages/mcp/src/caller-ua.json`. That list
     is empty at first. An entry is added only from a user-agent seen in the log lines below, never guessed, and
     only from a stated multi-day CLEAN capture window (R-S221-1). S224: no such window exists (the captures were
     lost with two Codespace deletions in 24 h, Nov 18–19); the list stays empty, and population is its own later
     micro-PR naming its window.
  3. Otherwise `unclassified`.
- What the instrument records:
  - The front logs one line per door request: `caller {"t","door","class","status","ua"}`. The user-agent is cut
    to 160 characters, and the line carries no IP.
  - `/metrics/reader` adds `nablaz_door_requests_total{door,class,stage}`. Stage `attempt` counts read attempts.
    Stage `served` counts reads (a `/read` answer, a `/feed` page or a tx answer) the reader answered 200.
  - The front passes the class to the reader as the internal headers `x-nablaz-door` and `x-nablaz-class`, on its
    own loopback fetches only. A caller's copy of those headers is never forwarded.
- Population, stated before any number: the counters cover read attempts and reads served at the four doors. MCP
  discovery calls (initialize, tools/list), 429s and a `/feed` or tx answered 503 while its flag is off appear only
  in the front's log lines. Until the site's proxy (`/api/sky` for the feed) sends `x-nablaz-caller: site` (a later
  web PR), site reads sit in `unclassified`.
- Counters start at 0 on every start, so a monthly reading is a scrape at each end of the window, with any reset
  acknowledged.
- Classes are internal bookkeeping. No class or count goes into a public answer or into public copy, and a class
  labels a caller of the doors, never a subject of the record.
- A spoofed `x-nablaz-caller` can only undercount outside reads, which raises the human gate earlier, never later.

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

`/metrics/reader` (above) is read the same way, with that path. First read on the hosted instance in S204: four
RPC legs, 0 errors.

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

S204-L5 (verbatim):
"The ephemeral console (R-S194-7) is a separate machine that shares only the database; anything on the reader's localhost is reached via flyctl ssh console on the live machine."

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

`<toBlock>` is each chain's current `ponder_sync_block`, read just before the run over `flyctl ssh console` on the
LIVE machine (Step S above), never in the ephemeral console: Ponder's `127.0.0.1:42069` exists only on that
machine (S204-L5).

On hosts whose `/dev/shm` rejects parallel workers (Fly Managed Postgres, ERROR 53100 "could not resize shared
memory segment", S204), run with `PGOPTIONS="-c max_parallel_workers_per_gather=0"`. R-S204-2: the report sets this
on its own Postgres session; the database's configuration is never changed to fit a reporting script. The durable
in-script fix landed in `openIndex` with #16, so a report from an image built after #16 needs no `PGOPTIONS`.

Population (2026-11-05): Arbitrum 42161 from block 283144909 = min(SpendPermissionManager 283144909,
DelegationManager 320575464, NablaZ 516635193), per `startBlockOf` in `src/chains.ts`; Base 8453 from block
23499060. The TEST account `0x8E65…b11c` is cited to `README.md` and the reader tests.

The first hosted run (2026-11-05) failed on the loader: exit 1 on both chains, `loadPgFromPonder` returned null.
Under plain node, `createRequire` on the pnpm link `node_modules/ponder` searched the link's parents, where pg is
absent; the loader now resolves Ponder's real directory first (s202-c-share-loader), and a unit test runs it under
plain node without `NODE_PATH`.

### Logs

`~/.fly/bin/flyctl logs -a nablaz-reader --no-tail` returns the last 100 lines only (S200: 100 lines, about 18 s,
both reads). It cannot reach an earlier day. Mask URLs before printing any line. For any window, capture with
`scripts/fly-log-poll.mjs` (schema event, step 2), not a streaming `flyctl logs`, which can stall silently (S221).

### Restart policy and exit 75 (S196–S197 record)

"restart-policy behavior row (exit 75 → flyd loop → autostart on next request)". Observed: "reader crash-looped
exit 75 from ~12:32Z Oct 30 under flyd policy"; "pipeline frozen on BOTH chains after two exit-75 restarts
20:46:49Z/21:01:00Z Oct 30; restart unfroze" (one restart by ruling 15:12:29Z Oct 31 unfroze it).

Not from record: exit 75 is Ponder's own exit code; from inside the image it does not say which failure caused
it (since S211 the DB watchdog also exits 75, after its `db watchdog FATAL` line). The start-up RPC check stops the
start only on an HTTP 401/403 leg (exit 78, R-S211-1); any other failing leg is named in a warning and the start
goes on. A restart after a
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

The GitHub Actions secrets `READER_LAB_ARB_RPC_URL` and `READER_LAB_BASE_RPC_URL` (the fork tests) carry an RPC URL
too: a lab key, never the production reader's. ci.yml maps each into the env names the fork suites read. On
2026-11-04 the fork tests' secrets of that time still carried the rotated key: every fork call answered HTTP 401
"Must be authenticated!". A rotation of the lab key updates them.

## Defaults (S198-L3)

Every load-bearing default is set in the repository or accepted here with its reason.

| Default | Value | Set or accepted |
| --- | --- | --- |
| Ponder `pollingInterval` | 1000 ms | Set for Base (2000 ms, `ponder.config.ts`; a polling interval, not Base's block time, which is ~0.2 s: S213 A1); accepted for Arbitrum: Ponder fetches every new block there, so a longer interval saves no calls (S192 measurement). |
| Ponder `ethGetLogsBlockRange` | unset | Accepted: per chain, it would cap the Alchemy leg too; the Chainstack cap (10,000 blocks) is held in `src/rpc.ts`. |
| Ponder per-request transport options | `retryCount: 0`, `timeout: 10_000` | Accepted: Ponder retries and load-balances itself (`ponder/dist/esm/rpc/index.js`). |
| viem `maxResponseBodySize` | 10,485,760 | Set to 32 MiB on every leg (R-S197-7). |
| viem client retries on the grounding client | 3, exponential from 150 ms | Accepted: grounding reads are served per request; a retry costs one more call, not a wrong answer. |
| Ponder Postgres pool `max` | 30 | Accepted: 2 internal plus 9 each for the read-only, user and sync pools under `ponder start`; 19 sessions read on 2026-11-04 against the limit of 50. |
| Ponder pool timeouts | read-only: `statement_timeout` 30 s, `work_mem` 16MB (512MB unpatched; `patches/ponder@0.18.6.patch`, S213), `lock_timeout` 500 ms; user and sync: `statement_timeout` 2 min; internal: 10 min | Accepted: Ponder sets them on its own clients (S198 §6); a `/read` query over 30 s is fixed by an index (S198, #10), not a longer timeout. |
| Ponder `ordering` | multichain | Set: `omnichain`. |
| Fly restart policy | not set in `fly.toml` | Accepted with the record above (exit 75 → flyd loop); the start-up RPC check warns and never exits non-zero, so it adds no restart. |
| Fly `http_service` check | Fly's, not relied on | Set: `GET /live`, 15 s interval, 5 s timeout, 60 s grace. |
| Fly autostop | Fly's, not relied on | Set: `auto_stop_machines = false`, `min_machines_running = 1`. |
| Front rate limit | 60 per IP per minute | Set: `DEFAULT_RATE_LIMIT_PER_MIN`, keyed by `Fly-Client-IP`. |
| Front relay fetch timeout | none | Accepted: a hung reader holds that request's socket only; the per-IP limit bounds how many one client can hold, and `/live` no longer calls the reader. |
| GET /feed | on (`NABLAZ_FEED=on`, machine env, S221) | Set: off in code unless `NABLAZ_FEED` is exactly `on` (`feedEnabled`, S213-SE7); flipped on 2026-11-15 after the R-S217-1 EXPLAIN gate (schema event, step 6). |
| GET /feed history (S233) | `?at`, `?include=settledValue`, settled-history `cache-control` | Set, additive, inside the feed's flag: `?at=<epoch s>` or `?at=<chainId>:<block>` serves the window at a position (`timeBound`/`blockBound`, `src/api/feed.ts`); a `<chainId>:<block>` position costs one `eth_getBlockByNumber` on the indexer's transport, bounded by the shared front window (60 per IP per minute, unchanged). A page whose bound is at least `HISTORY_SETTLED_SECONDS` (3600) old gets `HISTORY_CACHE_CONTROL` (`public, max-age=86400, immutable`), relayed by the front; the now-edge gets none. `?include=settledValue`: payment items' raw settled amount, cited (Task 3, S233). Measured record size and rate: `docs/measurements/s233-record-size.md`. |
| GET /read/:chainId/tx/:txHash | on (`NABLAZ_TX=on` machine env since 2026-11-24, S228) | Set: off in code unless `NABLAZ_TX` is exactly `on` (`txEnabled`, R-S226-4). Flip gates, both held at S228: the EXPLAIN on its `*_tx` indexes passed on all three chains, AND the per-IP bound on its RPC path (one `eth_getTransactionByHash` per miss) is stated: the shared front window, 60 per IP per minute, ruled no change. |

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

### Rollback and schema drops (R-S208-1)

- Rollback depends on the schemas kept. After the S208 schema drops, no fallback schema remains: only the live
  deployment's schema exists. Rolling back to any image that is not the live one is a full reindex into that
  image's own schema (its duration computed as under Deploys, never a carried figure). The recovery posture is
  fix-forward: correct the fault in a new commit and deploy it.
- Two gates are MANDATORY before every schema drop, and a drop does not proceed unless both hold:
  - G1: every view in `reader` references only the live schema (`pg_views`, `schemaname = 'reader'`, every
    definition read, not a sample).
  - G2: the schemas to be dropped have no external dependents: no view, function or other object outside them
    references them.

## Registration surfaces — publish procedure (EXECUTED S204)

Publish gate (S201): "nothing publishes and no chain tx until /ready 200." The gate opened at S204 (`/ready` 200)
and the procedure below was run in the founder publish sitting. Record:

```text
setAgentURI(1650 → https://read.nablaz.io/.well-known/agent-registration.json): tx 0x37803fb7146ffe683dc2e8ccac52c3ff19f78684132e4e46e1848e45cb1a64d7, Arbitrum One block 521814975
vault sweep (1.99 USDC): tx 0x1b88a09c0d83385a67c37919e67d5118917710b9f9d74561d37e969e1bb3e2a3, block 521815869
MCP Registry: io.nablaz/reader v0.1.0, publishedAt 2026-11-06T14:35:58.64909Z, status active
```

The steps below are kept as the procedure for a re-publish or a key rotation.

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

Executed S204 (record above). The agentURI value is `https://read.nablaz.io/.well-known/agent-registration.json`. The owner of
agentId 1650 sets it with `setAgentURI(uint256 agentId, string calldata newURI)` (EIP-8004) on the Identity
Registry on eip155:42161 (address in `packages/reader/src/generated/erc8004.json`), arguments
`1650, "https://read.nablaz.io/.well-known/agent-registration.json"`: a founder Ledger transaction from her
Mac. Before signing, `GET` the URI and confirm it serves the committed file.

### 2. MCP Registry (official)

Executed S204 (record above). From the registry's own docs (modelcontextprotocol/registry: `docs/modelcontextprotocol-io/`
`quickstart.mdx`, `authentication.mdx`, `remote-servers.mdx`, fetched S201).

Key pair, on the founder Mac only, kept in `~/Developer/nablaz/secrets/mcp-publisher/` (outside every repository).
The Ed25519 path needs OpenSSL 3 or later; macOS's system `openssl` (LibreSSL) fails with
`Algorithm Ed25519 not found`, so call OpenSSL 3 explicitly (`/opt/homebrew/opt/openssl@3/bin/openssl` on Apple
Silicon, after `brew install openssl@3`):

```bash
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
dig TXT nablaz.io +short
```

Install `mcp-publisher` (one release binary; `brew install mcp-publisher` also works):

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

Log in (R-S201-6 (b), amended): the key is passed to `--private-key` by command substitution from `key.pem`, so it
never renders in the terminal or the shell history. One `&&` chain, in a plain terminal, with OpenSSL 3 as `openssl`
(see the LibreSSL note above):

```bash
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
mcp-publisher validate
mcp-publisher publish
```

Verify through the registry API:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.nablaz/reader"
```

The registry does not check that the remote URL is on the authenticated domain, and each remote URL can be used by
one server name only. If keys are rotated, remove the old TXT record from the apex.

### 3. Secondary directories (the executed plan, S204)

- A — aggregator verify-only: PulseMCP, API Tracker and other registry-fed lists; checked a few days after publish.
- D — Anthropic Claude Connectors Directory submission (the README's "Using the hosted reader from Claude" section);
  OpenAI org verification in parallel.
- B — founder-typed GitHub-OAuth claims: Glama, mcp.so, MCP Market, cursor.directory, smithery.ai.
- C — awesome-mcp-servers and Cline Marketplace PRs (Docker MCP Catalog skipped: containerized servers only).
- E — OpenShell catalog and the plugin/skill shelf, each process confirmed before submission.

### Note: endpoint-domain verification

EIP-8004's optional endpoint-domain verification uses `https://{endpoint-domain}/.well-known/agent-registration.json`,
the path the front serves. For `read.nablaz.io` it is the same file the agentURI names. It would also apply to
`nablaz.io` (the `web` service endpoint), which this repository does not serve.
