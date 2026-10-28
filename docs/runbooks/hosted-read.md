# Hosted read on Railway

The hosted instance at `read.nablaz.io` (R-S193-1) is one Railway service running one instance with two doors
(R-S192-1): the reader, and the HTTP front of `packages/mcp`, which serves `POST /mcp` and relays `GET /read`
and `GET /ready` to the reader. `railway.json` is the service definition; `scripts/railway-start.sh` starts
both processes. No secret is in the repository: every value below is a Railway service variable.

## Service variables

| Variable | Value |
| --- | --- |
| `READER_ARBITRUM_RPC_URL` | Chainstack, chain 42161: head tracking and state reads |
| `READER_ARBITRUM_GROUNDING_RPC_URL` | Alchemy, chain 42161: backfill `eth_getLogs` and grounding reads |
| `READER_BASE_RPC_URL` | Chainstack, chain 8453 |
| `READER_BASE_GROUNDING_RPC_URL` | Alchemy, chain 8453 |
| `MCP_CLIENT_IP_HEADER` | `X-Real-IP`, the client-IP header Railway's edge overwrites |
| `DATABASE_URL` | a reference to the Railway Postgres service's `DATABASE_URL` |
| `MCP_RATE_LIMIT_PER_MIN` | optional, default 60 |

`PORT` and `RAILWAY_DEPLOYMENT_ID` are set by Railway. Leave `READER_EXTERNAL_FROM`, `READER_CHAINS`,
`READER_SOURCES`, `READER_START_BLOCK` and `READER_END_BLOCK` unset: every source starts at its deployment block.
The start script refuses to start without the four RPC variables, `MCP_CLIENT_IP_HEADER` and `DATABASE_URL`.

RPC roles (src/rpc.ts, R-S192-8): the grounding reads use the grounding URL only. The indexer sends range
`eth_getLogs` (backfill) to the grounding URL, and everything else to the Chainstack URL, falling back to the
grounding URL only when the Chainstack URL fails. A range `eth_getLogs` over 10,000 blocks is never sent to the
Chainstack URL.

## Deploys

`numReplicas` is 1: the rate limit is held in process, and one indexer writes the database. Each deployment
indexes into its own schema (`--schema $RAILWAY_DEPLOYMENT_ID`), as Ponder's Railway guide sets it; the views
schema `reader` points at the deployment that is live. Railway switches traffic once `GET /ready` answers 200,
within `healthcheckTimeout` (3600 s, Railway's maximum). The RPC cache (schema `ponder_sync`) is shared, so a
redeploy reindexes from the cache rather than from the RPCs. Ponder does not drop the schema of a deployment
that has been replaced; drop it by hand once the new deployment is live.

## Database backup (off-platform)

`pg_dump` runs daily from a host outside Railway, over Railway's public Postgres endpoint
(`DATABASE_PUBLIC_URL`, held only in that host's environment as `NABLAZ_READ_DATABASE_URL`). Fourteen dumps are
kept. The `pg_dump` major version must be at least the server's.

```cron
# m h dom mon dow   daily at 03:15 UTC
15 3 * * *  pg_dump --format=custom --no-owner --no-privileges --dbname="$NABLAZ_READ_DATABASE_URL" --file="$BACKUP_DIR/nablaz-read-$(date -u +\%Y\%m\%dT\%H\%MZ).dump" && find "$BACKUP_DIR" -name 'nablaz-read-*.dump' -mtime +14 -delete
```

Restore into an empty database with `pg_restore --no-owner --dbname="$TARGET_DATABASE_URL" <dump>`; it holds
`ponder_sync` and every deployment schema present when the dump was taken.
