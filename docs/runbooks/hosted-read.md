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
  and the reader process answers, whatever the index progress; 503 otherwise.
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
