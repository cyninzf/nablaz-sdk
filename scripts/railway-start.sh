#!/usr/bin/env bash
# The hosted instance on Railway (railway.json, docs/runbooks/hosted-read.md): one instance, two doors
# (R-S192-1). The reader listens on 127.0.0.1 only. The HTTP front (packages/mcp --transport http) listens on
# Railway's PORT, serves POST /mcp and relays GET /read and GET /ready to the reader. If either process exits,
# the other is stopped and the script exits non-zero, so Railway restarts the service.
# Every variable below is set in Railway's service variables; none is in the repo.
set -euo pipefail

: "${READER_ARBITRUM_RPC_URL:?}" "${READER_ARBITRUM_GROUNDING_RPC_URL:?}"
: "${READER_BASE_RPC_URL:?}" "${READER_BASE_GROUNDING_RPC_URL:?}"
: "${MCP_CLIENT_IP_HEADER:?set it to the client-IP header the edge overwrites}"
: "${DATABASE_URL:?}" "${PORT:?}" "${RAILWAY_DEPLOYMENT_ID:?}"
export PONDER_TELEMETRY_DISABLED=true
READER_PORT=42069

# A schema per deployment, as Ponder's Railway guide sets it, so a redeploy indexes beside the running one; the
# views schema "reader" always points at the live deployment. Ponder reads PORT before --port, so it is unset
# for the reader: PORT is the front's.
(cd packages/reader && exec env -u PORT node_modules/.bin/ponder start --schema "$RAILWAY_DEPLOYMENT_ID" --views-schema reader --hostname 127.0.0.1 --port "$READER_PORT") &
NABLAZ_READER_URL="http://127.0.0.1:$READER_PORT" node --experimental-strip-types --disable-warning=ExperimentalWarning packages/mcp/src/main.ts --transport http &

status=0
wait -n || status=$?
kill $(jobs -p) 2>/dev/null || true
wait || true
exit $((status == 0 ? 1 : status))
