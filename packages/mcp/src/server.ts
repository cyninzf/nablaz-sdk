// The MCP server core over the reader's GET /read, shared by the stdio and Streamable HTTP doors (R-S192-1). Reads
// only: one tool, no write, no signing, no key. The reader's JSON is returned byte for byte, after one line naming
// the chain and the as-of block; a reader 4xx body as-is; a reader 5xx as a fixed text, its body logged only.
// Until the index is ready (the reader's /ready, R-S202-4) the tool answers {"ready":false} and reads nothing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** The reader `pnpm start` serves locally (ponder's default port). */
export const DEFAULT_READER_URL = "http://localhost:42069";

export const READ_TOOL = "read_subject";

/** Two sentences: the source-and-label model and what a nothing-indexed note means. */
export const READ_TOOL_DESCRIPTION =
  "Returns every fact the reader has indexed about an address on one chain, as GET /read/:chainId/:address JSON: each fact names its source, carries a permission label of shape (a) to (e), and cites the block, transaction and log index with a command that returns the same log from any RPC. " +
  "A note reading nothing indexed (blocks X..Y) covers only that block range, and does not mean nothing happened on chain.";

/** How much of a reader error body the server-side log keeps. */
const LOGGED_BODY_MAX = 2_000;

/**
 * A reader 5xx body is the reader's internals (a driver message, a filesystem path), not an answer (R-S198-3/4):
 * it goes to stderr only, first LOGGED_BODY_MAX characters. A 4xx body is reader-authored and is relayed.
 */
export function logReaderError(status: number, path: string, body: string): void {
  console.error(`reader ${status} on GET ${path}: ${body.slice(0, LOGGED_BODY_MAX)}`);
}

/** The not-ready answer of both doors (R-S202-4), in /ready's vocabulary (R-S193-13): no record, never an empty one. */
export const NOT_READY_BODY = `{"ready":false}`;

export type Readiness = "ready" | "not ready" | "unreachable";

/**
 * The one readiness check of both doors (R-S202-4): the reader's GET /ready, which Ponder answers from the running
 * app's own is_ready (200 when 1). An unready schema's tables are partial, so a read from one is absence, not a
 * record (R-S189-6). Any answer but 200 is not ready; a 5xx on /ready is logged, its body never relayed.
 */
export async function readerReadiness(base: string, get: typeof fetch): Promise<Readiness> {
  let r: Response;
  try {
    r = await get(new URL("/ready", base));
  } catch (e) {
    console.error(`reader unreachable on GET /ready: ${String(e)}`);
    return "unreachable";
  }
  const body = await r.text();
  if (r.status === 200) return "ready";
  if (r.status >= 500 && r.status !== 503) logReaderError(r.status, "/ready", body);
  return "not ready";
}

export type ReadServerOptions = {
  /** Reader base URL. Default DEFAULT_READER_URL. */
  readerUrl?: string;
  fetch?: typeof fetch;
};

export function readServer(opts: ReadServerOptions = {}): McpServer {
  const base = opts.readerUrl ?? DEFAULT_READER_URL;
  const get = opts.fetch ?? fetch;
  const server = new McpServer({ name: "nablaz-read", version: "0.1.0" });
  server.registerTool(
    READ_TOOL,
    {
      title: "Read indexed facts about an address",
      description: READ_TOOL_DESCRIPTION,
      inputSchema: {
        chainId: z.number().int().positive().describe("EVM chain id, for example 42161 (Arbitrum One) or 8453 (Base)"),
        address: z.string().describe("The subject address, 0x-prefixed"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chainId, address }) => {
      const url = new URL(`/read/${chainId}/${encodeURIComponent(address)}`, base);
      const readiness = await readerReadiness(base, get);
      if (readiness === "unreachable") return { isError: true, content: [{ type: "text", text: "the reader did not answer" }] };
      // R-S202-4: not ready is the same {"ready":false} as /read's 503, never an empty record.
      if (readiness === "not ready") return { isError: true, content: [{ type: "text", text: `GET ${url.pathname}: HTTP 503` }, { type: "text", text: NOT_READY_BODY }] };
      let res: Response;
      try {
        res = await get(url);
      } catch (e) {
        // The reader's URL (a loopback address) and the fetch error text are the server's, not the caller's (row K).
        console.error(`reader unreachable on GET ${url.pathname}: ${String(e)}`);
        return { isError: true, content: [{ type: "text", text: "the reader did not answer" }] };
      }
      const body = await res.text();
      if (res.status >= 500) logReaderError(res.status, url.pathname, body);
      if (!res.ok) {
        const text = res.status >= 500 ? `reader error (status ${res.status})` : body;
        return { isError: true, content: [{ type: "text", text: `GET ${url.pathname}: HTTP ${res.status}` }, { type: "text", text }] };
      }
      const { asOfBlock } = JSON.parse(body) as { asOfBlock?: string };
      return { content: [{ type: "text", text: `chain ${chainId}, as of block ${asOfBlock}` }, { type: "text", text: body }] };
    },
  );
  return server;
}
