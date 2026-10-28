// The HTTP front of one instance with two doors (R-S192-1). POST /mcp: Streamable HTTP onto the same read
// server, stateless, one fresh server and transport per request, the same single read_subject tool. GET
// /read/:chainId/:address and GET /ready: relayed to the reader unchanged (status, content type, body bytes), so
// the reader itself need not be public. Every request is rate-limited per IP in process so the limit holds
// whatever sits in front. The IP is the socket peer, or, when MCP_CLIENT_IP_HEADER names a header the edge
// overwrites (X-Real-IP on Railway), that header's value. No CORS headers, no counts or metrics endpoint;
// any other path is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DEFAULT_READER_URL, readServer, type ReadServerOptions } from "./server.ts";

export const DEFAULT_PORT = 3042;
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const MCP_PATH = "/mcp";
/** The reader paths the front relays: the read and the readiness probe. Nothing else of the reader is public. */
const READER_PATH = /^\/read\/[^/]+\/[^/]+$|^\/ready$/;

export type HttpServerOptions = ReadServerOptions & {
  /** Requests per IP per minute. Default DEFAULT_RATE_LIMIT_PER_MIN. */
  rateLimitPerMin?: number;
  /** A header the proxy in front sets to the client IP, overwriting any the client sent. Unset: the socket peer. */
  clientIpHeader?: string;
};

/** The rate-limit key: the named header's value when one is named and present, else the socket peer. */
export function clientIp(req: IncomingMessage, clientIpHeader?: string): string {
  const v = clientIpHeader ? req.headers[clientIpHeader.toLowerCase()] : undefined;
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

/** GET `path` on the reader; its status, content type and body go back unchanged. */
async function relay(res: ServerResponse, readerUrl: string, path: string, get: typeof fetch) {
  let r: Response;
  try {
    r = await get(new URL(path, readerUrl));
  } catch {
    return plain(res, 502, "reader unreachable\n");
  }
  const body = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/octet-stream" }).end(body);
}

export function readHttpServer(opts: HttpServerOptions = {}): Server {
  const allow = rateLimiter(opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN);
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!allow(clientIp(req, opts.clientIpHeader))) return plain(res, 429, "rate limit exceeded, try again in a minute\n");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && READER_PATH.test(path)) return relay(res, opts.readerUrl ?? DEFAULT_READER_URL, path, opts.fetch ?? fetch);
    if (path !== MCP_PATH) return plain(res, 404, "not found\n");
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
