// The stdio MCP server against a real reader: Base, third-party sources, over the fixed window that
// packages/reader/test/fork/external.fork.test.ts uses. The tool's JSON is byte-identical to GET /read, and an
// unknown chain gets the API's own 404 message. Read-only: no anvil, no transaction.

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UPSTREAM_BASE, indexOnce, type Served } from "../../../reader/test/fork/harness.ts";
import { READ_TOOL } from "../../src/server.ts";

if (!UPSTREAM_BASE) throw new Error("READER_BASE_RPC_URL is not set: the fork tests do not skip");

const READER_DIR = fileURLToPath(new URL("../../../reader/", import.meta.url));
// The Base delegator external.fork.test.ts reads in the same window.
const SUBJECT = "0x92397432579b91B6De49f0f14AfF64628912667D";
const WINDOW = { from: 53_160_000, to: 53_160_200 };

let served: Served;
let client: Client;

beforeAll(async () => {
  served = await indexOnce({ cwd: READER_DIR, baseRpcUrl: UPSTREAM_BASE, chains: "8453", sources: "external", startBlock: WINDOW.from, endBlock: WINDOW.to, serve: true });
  client = new Client({ name: "fork-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../../src/main.ts", import.meta.url)), "--reader-url", served.url],
      stderr: "pipe",
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await served?.stop();
});

const texts = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[]).map((c) => c.text);

describe("MCP read over a live reader", () => {
  it("returns GET /read's body byte for byte, after the as-of block", async () => {
    const direct = await (await fetch(`${served.url}/read/8453/${SUBJECT}`)).text();
    const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 8453, address: SUBJECT } });
    expect(r.isError).toBeFalsy();
    const [head, body] = texts(r);
    expect(body).toBe(direct);
    const parsed = JSON.parse(body!) as { asOfBlock: string; facts: unknown[] };
    expect(head).toBe(`chain 8453, as of block ${parsed.asOfBlock}`);
    expect(BigInt(parsed.asOfBlock)).toBe(BigInt(WINDOW.to));
    expect(parsed.facts.length).toBeGreaterThan(0);
  });

  it("an unknown chain gets the API's 404 message", async () => {
    const direct = await fetch(`${served.url}/read/1/${SUBJECT}`);
    expect(direct.status).toBe(404);
    const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 1, address: SUBJECT } });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual([`GET /read/1/${SUBJECT}: HTTP 404`, await direct.text()]);
    expect(texts(r)[1]).toBe(`{"error":"chain 1 is not read here"}`);
  });
});
