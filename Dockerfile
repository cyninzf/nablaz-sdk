# The hosted reader and its HTTP front (R-S193-12; fly.toml, docs/runbooks/hosted-read.md). No secret is baked
# in: every RPC URL, MCP_CLIENT_IP_HEADER and DATABASE_URL arrive as runtime environment.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# Manifests first, so the install layer is cached until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/reader/package.json packages/reader/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile
COPY . .
# No package has a build step today (TypeScript runs as source); kept so one added later runs here.
RUN pnpm -r build

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable \
  && groupmod --new-name reader node \
  && usermod --login reader --home /home/reader --move-home node
COPY --from=build --chown=reader:reader /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=reader:reader /app/node_modules ./node_modules
COPY --from=build --chown=reader:reader /app/packages ./packages
COPY --from=build --chown=reader:reader /app/scripts/reader-start.sh ./scripts/
USER reader
ENV NODE_ENV=production
CMD ["bash", "scripts/reader-start.sh"]
