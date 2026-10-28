#!/usr/bin/env bash
# The hosted instance on Fly (fly.toml, docs/runbooks/hosted-read.md): one instance, two doors (R-S192-1).
# The reader listens on 127.0.0.1 only. The HTTP front (packages/mcp --transport http) listens on PORT, serves
# POST /mcp and relays GET /read and GET /ready to the reader. If either process exits, the other is stopped
# and the script exits non-zero, so the machine restarts.
# Every variable below is a Fly secret, set by Fly, or set in fly.toml; none is in the repo.
set -euo pipefail

: "${READER_ARBITRUM_RPC_URL:?}" "${READER_ARBITRUM_GROUNDING_RPC_URL:?}"
: "${READER_BASE_RPC_URL:?}" "${READER_BASE_GROUNDING_RPC_URL:?}"
: "${MCP_CLIENT_IP_HEADER:?set it to the client-IP header the edge overwrites}"
: "${DATABASE_URL:?}" "${PORT:?}" "${FLY_IMAGE_REF:?}"
export PONDER_TELEMETRY_DISABLED=true
READER_PORT=42069
# The deployment's image tag (registry.fly.io/<app>:deployment-<id>), one per deploy; Ponder allows 45 characters.
ref=${FLY_IMAGE_REF%%@*}
SCHEMA=$(printf '%s' "${ref##*:}" | tr 'A-Z' 'a-z' | cut -c1-45)

# A schema per deployment, as Ponder's guide for hosted deploys sets it, so a redeploy indexes beside the running one; the
# views schema "reader" always points at the live deployment. Ponder reads PORT before --port, so it is unset
# for the reader: PORT is the front's.
(cd packages/reader && exec env -u PORT node_modules/.bin/ponder start --schema "$SCHEMA" --views-schema reader --hostname 127.0.0.1 --port "$READER_PORT") &
NABLAZ_READER_URL="http://127.0.0.1:$READER_PORT" node --experimental-strip-types --disable-warning=ExperimentalWarning packages/mcp/src/main.ts --transport http &

status=0
wait -n || status=$?
kill $(jobs -p) 2>/dev/null || true
wait || true
exit $((status == 0 ? 1 : status))
