// Streamable HTTP door onto the same read server (R-S192-1): POST /mcp, stateless, one fresh server and
// transport per request, the same single read_subject tool. Rate-limited per IP in process so the limit holds
// whatever sits in front. No CORS headers, no counts or metrics endpoint; anything but /mcp is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readServer, type ReadServerOptions } from "./server.ts";

export const DEFAULT_PORT = 3042;
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const MCP_PATH = "/mcp";

export type HttpServerOptions = ReadServerOptions & {
  /** Requests per IP per minute. Default DEFAULT_RATE_LIMIT_PER_MIN. */
  rateLimitPerMin?: number;
};

/** Fixed one-minute window per remote address. */
function rateLimiter(perMin: number) {
  let windowStart = Date.now();
  const counts = new Map<string, number>();
  return (ip: string): boolean => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      counts.clear();
    }
    const n = (counts.get(ip) ?? 0) + 1;
    counts.set(ip, n);
    return n <= perMin;
  };
}

function plain(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
}

export function readHttpServer(opts: HttpServerOptions = {}): Server {
  const allow = rateLimiter(opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN);
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!allow(req.socket.remoteAddress ?? "")) return plain(res, 429, "rate limit exceeded, try again in a minute\n");
    if (new URL(req.url ?? "/", "http://x").pathname !== MCP_PATH) return plain(res, 404, "not found\n");
    // Stateless: no session, no server-initiated stream, so only POST carries a request.
    if (req.method !== "POST") return res.writeHead(405, { allow: "POST", "content-type": "text/plain; charset=utf-8" }).end("method not allowed\n");
    const server = readServer(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) plain(res, 500, `internal error: ${String(e)}\n`);
    }
  });
}
