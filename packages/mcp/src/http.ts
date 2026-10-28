// Streamable HTTP door onto the same read server (R-S192-1): POST /mcp, stateless, one fresh server and
// transport per request, the same single read_subject tool. Rate-limited per IP in process so the limit holds
// whatever sits in front. The IP is the socket peer, or, when TRUST_PROXY names a header the edge overwrites
// (X-Real-IP on Railway), that header's value. No CORS headers, no counts or metrics endpoint; anything but
// /mcp is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readServer, type ReadServerOptions } from "./server.ts";

export const DEFAULT_PORT = 3042;
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const MCP_PATH = "/mcp";

export type HttpServerOptions = ReadServerOptions & {
  /** Requests per IP per minute. Default DEFAULT_RATE_LIMIT_PER_MIN. */
  rateLimitPerMin?: number;
  /** A header the proxy in front sets to the client IP, overwriting any the client sent. Unset: the socket peer. */
  trustProxy?: string;
};

/** The rate-limit key: the trusted header's value when one is named and present, else the socket peer. */
export function clientIp(req: IncomingMessage, trustProxy?: string): string {
  const v = trustProxy ? req.headers[trustProxy.toLowerCase()] : undefined;
  const header = (Array.isArray(v) ? v[0] : v)?.trim();
  return header || (req.socket.remoteAddress ?? "");
}

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
    if (!allow(clientIp(req, opts.trustProxy))) return plain(res, 429, "rate limit exceeded, try again in a minute\n");
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
