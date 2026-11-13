// The HTTP front of one instance with two doors (R-S192-1). POST /mcp: Streamable HTTP onto the same read
// server, stateless, one fresh server and transport per request, the same single read_subject tool. GET
// /read/:chainId/:address, GET /feed and GET /ready: relayed to the reader, so the reader itself need not be public; a
// reader-authored answer unchanged (status, content type, body bytes), a 5xx with a fixed body (relay below). GET /read
// and GET /feed answer 503 {"ready":false} with nothing read until the reader's readiness is 200 (R-S202-4, the check
// shared with the MCP tool). GET /feed is OFF unless feedEnabled (NABLAZ_FEED=on, S213-SE7): off, it answers 503
// {"ready":false} at once, with no readiness check and nothing relayed, until the index its queries need ships. GET /ready is the reader's /ready/head (S213 B1): 200 only when the index is ready AND
// current with both chain heads. GET /live: 200 when the front is up and the reader process runs
// (by PID when readerPid is set, off the reader's event loop; else its /health answers), 503 otherwise, whatever the index progress (deploy health; /ready is index readiness). Every request is rate-limited per IP in process so the limit holds
// whatever sits in front. The IP is the socket peer, or, when MCP_CLIENT_IP_HEADER names a header the edge
// overwrites (Fly-Client-IP on Fly), that header's value. No CORS headers, no counts or metrics endpoint.
// P-GTM-4 (R-S214-11, R-S217-7): every request at the two read doors (GET /read/*, /mcp) gets a caller class from its
// own headers (caller.ts), in memory, before anything else; one log line per such request on stderr (door, class,
// status, truncated user-agent, time; no IP); and the class rides the front's own loopback fetches to the reader (the
// readiness check and the /read relay) as internal headers, which the reader counts on /metrics/reader. Nothing of it
// is in any response: status, headers and body bytes are what they were.
// GET /.well-known/agent-registration.json: the ERC-8004 registration file at EIP-8004's own path (also its
// endpoint-domain verification artifact; packages/mcp/static/), the bytes read once at start-up. GET /favicon.ico: the
// committed NablaZ icon (R-S205-6), image/png, cached as immutable. Any other path, any other /.well-known path included, is 404.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callerLogLine, classify, doorOf, tagged } from "./caller.ts";
import { DEFAULT_READER_URL, logReaderError, NOT_READY_BODY, READER_READY_PATH, readerReadiness, readServer, type ReadServerOptions } from "./server.ts";

export const DEFAULT_PORT = 3042;
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const MCP_PATH = "/mcp";
/** The ERC-8004 registration file's path, EIP-8004's conventional name (R-S201-6): the agentURI of agentId 1650 points here. */
export const REGISTRATION_PATH = "/.well-known/agent-registration.json";
/** The committed registration file, read once at module load; served as these bytes, never re-read per request. */
const REGISTRATION_FILE = readFileSync(new URL("../static/agent-registration.json", import.meta.url));
/** R-S205-6: the favicon path and the committed icon (nablaz.io/press-kit/nablaz-icon-256.png, sha256 31af057a…8e97,
 * checked before commit), read once at module load like the registration file. */
export const FAVICON_PATH = "/favicon.ico";
const FAVICON_PNG = readFileSync(new URL("../static/nablaz-icon-256.png", import.meta.url));
/** The reader paths the front relays: the read (READ_PATH), the feed (FEED_PATH, with its query) and the readiness
 * probe /ready (the reader's READER_READY_PATH). Nothing else of the reader is public. */
const READ_PATH = /^\/read\/[^/]+\/[^/]+$/;
export const FEED_PATH = "/feed";

export type HttpServerOptions = ReadServerOptions & {
  /** Requests per IP per minute. Default DEFAULT_RATE_LIMIT_PER_MIN. */
  rateLimitPerMin?: number;
  /** A header the proxy in front sets to the client IP, overwriting any the client sent. Unset: the socket peer. */
  clientIpHeader?: string;
  /**
   * The reader process's PID (NABLAZ_READER_PID, set by scripts/reader-start.sh). Set: GET /live is 200 while that
   * process runs, without an HTTP call into it, so a stalled Ponder event loop does not fail deploy health
   * (R-S194-15). Unset: /live asks the reader's /health.
   */
  readerPid?: number;
  /**
   * GET /feed is served (S213-SE7). Default false: every /feed request answers 503 {"ready":false} at once and the
   * reader is not asked. main.ts sets it from FEED_ENV ("on" only), the variable the reader's own /feed reads.
   */
  feedEnabled?: boolean;
};

/** The variable that turns GET /feed on, here and in the reader (packages/reader/src/api/feed.ts). */
export const FEED_ENV = "NABLAZ_FEED";

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

/** True while process `pid` exists (signal 0 checks, sends nothing). EPERM: it exists under another user. */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 200 when the reader process answers GET /health (it does from start-up, before the index has caught up). */
async function live(res: ServerResponse, readerUrl: string, get: typeof fetch) {
  try {
    const r = await get(new URL("/health", readerUrl), { signal: AbortSignal.timeout(2_000) });
    if (r.ok) return plain(res, 200, "live\n");
  } catch {}
  plain(res, 503, "reader process not answering\n");
}

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const notReady = (res: ServerResponse) => res.writeHead(503, { "content-type": "application/json" }).end(NOT_READY_BODY);

/**
 * GET /read/* and GET /feed behind the readiness gate (R-S202-4): the shared readerReadiness check first, the read
 * relayed only when the index is ready; otherwise 503 {"ready":false} and nothing read. `path` may carry a query.
 */
async function gatedRead(res: ServerResponse, readerUrl: string, path: string, get: typeof fetch) {
  const readiness = await readerReadiness(readerUrl, get);
  if (readiness === "unreachable") return plain(res, 502, "reader unreachable\n");
  if (readiness === "not ready") return notReady(res);
  return relay(res, readerUrl, path, get);
}

/**
 * GET `path` on the reader (R-S198-3/4). Below 500 the answer is reader-authored and goes back unchanged (status,
 * content type, body bytes). READER_READY_PATH at 503 is the index not caught up: the front's own {"ready":false}. Any other
 * 5xx: {"error":"internal error"}, the reader's body (a driver message, a filesystem path) to the server log only.
 */
async function relay(res: ServerResponse, readerUrl: string, path: string, get: typeof fetch) {
  let r: Response;
  try {
    r = await get(new URL(path, readerUrl));
  } catch {
    return plain(res, 502, "reader unreachable\n");
  }
  const body = Buffer.from(await r.arrayBuffer());
  if (r.status < 500) return res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/octet-stream" }).end(body);
  if (path === READER_READY_PATH && r.status === 503) return notReady(res);
  logReaderError(r.status, path, body.toString("utf8"));
  json(res, r.status, { error: "internal error" });
}

export function readHttpServer(opts: HttpServerOptions = {}): Server {
  const allow = rateLimiter(opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN);
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // P-GTM-4: header parsing only (no I/O); the line is written when the response closes, 429s included.
    const door = doorOf(req.method, req.url, READ_PATH, MCP_PATH);
    const cls = door ? classify(req.headers) : null;
    if (door && cls) {
      const ua = req.headers["user-agent"];
      res.on("close", () => console.error(callerLogLine(door, cls, res.writableFinished ? res.statusCode : "aborted", ua)));
    }
    if (!allow(clientIp(req, opts.clientIpHeader))) return plain(res, 429, "rate limit exceeded, try again in a minute\n");
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (req.method === "GET" && path === "/live") {
      if (opts.readerPid !== undefined) return processRunning(opts.readerPid) ? plain(res, 200, "live\n") : plain(res, 503, "reader process not running\n");
      return live(res, opts.readerUrl ?? DEFAULT_READER_URL, opts.fetch ?? fetch);
    }
    if (req.method === "GET" && path === REGISTRATION_PATH) return res.writeHead(200, { "content-type": "application/json" }).end(REGISTRATION_FILE);
    if (req.method === "GET" && path === FAVICON_PATH) return res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" }).end(FAVICON_PNG);
    if (req.method === "GET" && READ_PATH.test(path)) return gatedRead(res, opts.readerUrl ?? DEFAULT_READER_URL, path, tagged(opts.fetch ?? fetch, "read", cls ?? "unclassified"));
    if (req.method === "GET" && path === FEED_PATH && !opts.feedEnabled) return notReady(res);
    if (req.method === "GET" && path === FEED_PATH) return gatedRead(res, opts.readerUrl ?? DEFAULT_READER_URL, `${path}${url.search}`, opts.fetch ?? fetch);
    if (req.method === "GET" && path === "/ready") return relay(res, opts.readerUrl ?? DEFAULT_READER_URL, READER_READY_PATH, opts.fetch ?? fetch);
    if (path !== MCP_PATH) return plain(res, 404, "not found\n");
    // Stateless: no session, no server-initiated stream, so only POST carries a request.
    if (req.method !== "POST") return res.writeHead(405, { allow: "POST", "content-type": "text/plain; charset=utf-8" }).end("method not allowed\n");
    const server = readServer({ ...opts, fetch: tagged(opts.fetch ?? fetch, "mcp", cls ?? "unclassified") });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      // The exception (message and stack) is the server's, not the caller's (R-S198-4).
      console.error(`mcp request failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) plain(res, 500, "internal error\n");
    }
  });
}
