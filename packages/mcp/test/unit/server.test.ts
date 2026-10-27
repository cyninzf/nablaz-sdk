// The MCP read server against a local HTTP stub of GET /read: pass-through, reads only, the API's errors as-is,
// the stdio entry point, and the wording rules (no score, verdict, ranking, trust, reputation or credit-bureau
// wording; "nothing indexed", not "none").

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_READER_URL, READ_TOOL, READ_TOOL_DESCRIPTION, readServer } from "../../src/server.ts";

const TEST = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
// Not the reader's formatting on purpose: the body must come back byte for byte, not re-serialized.
const BODY = `{"subject":"${TEST}",  "chainId":42161,"asOfBlock":"518782876","facts":[],"selfDealing":null,"exposure":null,"notes":["x: empty (blocks 1..2)"]}`;
const NOT_READ = `{"error":"chain 1 is not read here"}`;
const MAIN = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const NODE_ARGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
const BANNED = /score|verdict|rank|trust|reputation|credit bureau/i;

let stub: Server;
let base: string;
const seen: string[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    seen.push(req.url!);
    const m = req.url!.match(/^\/read\/(\d+)\/(.+)$/);
    if (!m) return res.writeHead(404).end();
    if (m[1] !== "42161") return res.writeHead(404, { "content-type": "application/json" }).end(NOT_READ);
    res.writeHead(200, { "content-type": "application/json" }).end(BODY);
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => stub.close(() => r())));

async function connected(readerUrl = base) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await readServer({ readerUrl }).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}
const texts = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[]).map((c) => c.text);

describe("read_subject", () => {
  it("calls GET /read/:chainId/:address and returns the body unchanged, after the as-of block", async () => {
    const client = await connected();
    seen.length = 0;
    const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: TEST } });
    expect(seen).toEqual([`/read/42161/${TEST}`]);
    expect(r.isError).toBeFalsy();
    expect(texts(r)).toEqual(["chain 42161, as of block 518782876", BODY]);
  });

  it("an unknown chain gets the API's 404 message, as-is", async () => {
    const client = await connected();
    const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 1, address: TEST } });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual([`GET /read/1/${TEST}: HTTP 404`, NOT_READ]);
  });

  it("the address cannot reach another endpoint", async () => {
    const client = await connected();
    seen.length = 0;
    await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: "../../status" } });
    expect(seen).toEqual(["/read/42161/..%2F..%2Fstatus"]);
  });

  it("a reader that does not answer is an error, not an empty read", async () => {
    const client = await connected("http://127.0.0.1:1");
    const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: TEST } });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/^the reader at http:\/\/127\.0\.0\.1:1 did not answer/);
  });
});

describe("reads only", () => {
  it("exposes one tool, read-only; no write, signing or payment tool, no prompt, no resource", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([READ_TOOL]);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(Object.keys(tools[0]!.inputSchema.properties ?? {}).sort()).toEqual(["address", "chainId"]);
    const caps = client.getServerCapabilities()!;
    expect(caps.prompts).toBeUndefined();
    expect(caps.resources).toBeUndefined();
  });

  it("defaults to the local reader when neither --reader-url nor NABLAZ_READER_URL is set", async () => {
    const env = { ...(process.env as Record<string, string>) };
    delete env.NABLAZ_READER_URL;
    const transport = new StdioClientTransport({ command: process.execPath, args: [...NODE_ARGS, MAIN], env, stderr: "pipe" });
    let err = "";
    transport.stderr!.on("data", (d) => (err += d));
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      for (let i = 0; i < 50 && !err.includes("reader "); i++) await new Promise((r) => setTimeout(r, 100));
      expect(DEFAULT_READER_URL).toBe("http://localhost:42069");
      expect(err).toContain(`reader ${DEFAULT_READER_URL}`);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("stdio entry point", () => {
  it("serves the same tool over stdio, with the reader URL from NABLAZ_READER_URL", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...NODE_ARGS, MAIN],
      env: { ...(process.env as Record<string, string>), NABLAZ_READER_URL: base },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([READ_TOOL]);
      const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: TEST } });
      expect(texts(r)[1]).toBe(BODY);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("wording", () => {
  const skill = readFileSync(new URL("../../../../skills/read-record/SKILL.md", import.meta.url), "utf8");
  it("the tool description is at most two sentences and uses none of the banned words", () => {
    expect(READ_TOOL_DESCRIPTION).not.toMatch(BANNED);
    expect(READ_TOOL_DESCRIPTION.split(/\.\s/).length).toBeLessThanOrEqual(2);
  });
  it("the skill uses none of the banned words outside its own list of them", () => {
    const outside = skill.replace(/<!-- banned:start -->[\s\S]*?<!-- banned:end -->/g, "");
    expect(outside).not.toMatch(BANNED);
  });
  it("the skill says nothing indexed, never none, and never labels a payer an agent", () => {
    expect(skill).toContain("nothing indexed");
    expect(skill).not.toMatch(/\bnone\b/i);
    expect(skill).not.toMatch(/\b(?:the|an?) agent paid\b|\bpayer is an agent\b/i);
  });
});
