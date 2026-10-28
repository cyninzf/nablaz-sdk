#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// Entry point. --transport stdio (default) or http. The reader URL comes from --reader-url or NABLAZ_READER_URL,
// default the local reader. On stdio, stdout carries the protocol; nothing else is written to it. On http, the
// port comes from --port or PORT (default 3042), the per-IP limit from MCP_RATE_LIMIT_PER_MIN (default 60),
// and MCP_CLIENT_IP_HEADER names the header that carries the client IP (unset: the socket peer).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_READER_URL, readServer } from "./server.ts";
import { DEFAULT_PORT, DEFAULT_RATE_LIMIT_PER_MIN, MCP_PATH, readHttpServer } from "./http.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const readerUrl = arg("--reader-url") ?? process.env.NABLAZ_READER_URL ?? DEFAULT_READER_URL;
const transport = arg("--transport") ?? "stdio";

if (transport === "stdio") {
  await readServer({ readerUrl }).connect(new StdioServerTransport());
  console.error(`nablaz-read MCP server on stdio, reader ${readerUrl}`);
} else if (transport === "http") {
  const port = Number(arg("--port") ?? process.env.PORT ?? DEFAULT_PORT);
  const rateLimitPerMin = Number(process.env.MCP_RATE_LIMIT_PER_MIN ?? DEFAULT_RATE_LIMIT_PER_MIN);
  if (!Number.isInteger(port) || port < 0) throw new Error(`invalid port: ${port}`);
  if (!Number.isInteger(rateLimitPerMin) || rateLimitPerMin < 1) throw new Error(`invalid MCP_RATE_LIMIT_PER_MIN: ${rateLimitPerMin}`);
  const clientIpHeader = process.env.MCP_CLIENT_IP_HEADER || undefined;
  const server = readHttpServer({ readerUrl, rateLimitPerMin, clientIpHeader });
  server.listen(port, () => {
    const { port: bound } = server.address() as { port: number };
    console.error(`nablaz-read MCP server on http port ${bound} path ${MCP_PATH}, reader ${readerUrl}, ${rateLimitPerMin} requests/min per IP from ${clientIpHeader ?? "the socket peer"}`);
  });
} else {
  throw new Error(`--transport must be stdio or http, not ${transport}`);
}
