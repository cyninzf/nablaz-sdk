// A stdio MCP server over the reader's GET /read (R-S189-2: run locally; no hosted URL is assumed). Reads only:
// one tool, no write, no signing, no key. The reader's JSON is returned byte for byte, after one line naming
// the chain and the as-of block.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** The reader `pnpm start` serves locally (ponder's default port). */
export const DEFAULT_READER_URL = "http://localhost:42069";

export const READ_TOOL = "read_subject";

/** Two sentences: the source-and-label model and what an empty note means. */
export const READ_TOOL_DESCRIPTION =
  "Returns every fact the reader has indexed about an address on one chain, as GET /read/:chainId/:address JSON: each fact names its source, carries a permission label of shape (a) to (e), and cites the block, transaction and log index with a command that returns the same log from any RPC. " +
  "A note that a source is empty means nothing indexed for that source in the stated block range, not that nothing happened on chain.";

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
      let res: Response;
      try {
        res = await get(url);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `the reader at ${base} did not answer: ${String(e)}` }] };
      }
      const body = await res.text();
      if (!res.ok) return { isError: true, content: [{ type: "text", text: `GET ${url.pathname}: HTTP ${res.status}` }, { type: "text", text: body }] };
      const { asOfBlock } = JSON.parse(body) as { asOfBlock?: string };
      return { content: [{ type: "text", text: `chain ${chainId}, as of block ${asOfBlock}` }, { type: "text", text: body }] };
    },
  );
  return server;
}
