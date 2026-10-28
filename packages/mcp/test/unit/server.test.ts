// The MCP read server against a local HTTP stub of GET /read: pass-through, reads only, the API's errors as-is,
// the stdio and Streamable HTTP entry points (same result, byte for byte), the HTTP rate limit, and the wording rules (no score, verdict, ranking, trust, reputation or credit-bureau
// wording; "nothing indexed", not "none").

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_READER_URL, READ_TOOL, READ_TOOL_DESCRIPTION, readServer } from "../../src/server.ts";
import { MCP_PATH, readHttpServer } from "../../src/http.ts";
import { bannedHits } from "../../../reader/src/wording.ts";

const TEST = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
// Not the reader's formatting on purpose: the body must come back byte for byte, not re-serialized.
const BODY = `{"subject":"${TEST}",  "chainId":42161,"asOfBlock":"518782876","facts":[],"selfDealing":null,"exposure":null,"notes":["x: nothing indexed (blocks 1..2)"]}`;
const NOT_READ = `{"error":"chain 1 is not read here"}`;
const MAIN = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const NODE_ARGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

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

  it("a reader that does not answer is an error, not a read with nothing indexed", async () => {
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

async function overStdio(readerUrl: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...NODE_ARGS, MAIN],
    env: { ...(process.env as Record<string, string>), NABLAZ_READER_URL: readerUrl },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

/** Spawns main.ts --transport http on a free port; resolves once it logs the port it bound. */
async function overHttp(readerUrl: string) {
  const child = spawn(process.execPath, [...NODE_ARGS, MAIN, "--transport", "http", "--port", "0", "--reader-url", readerUrl], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let err = "";
    child.stderr!.on("data", (d) => {
      err += d;
      const m = err.match(/http port (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`)));
  return { client, port, stop: async () => (await client.close(), child.kill()) };
}

describe("entry points", () => {
  it("serves the same tool over stdio and Streamable HTTP; both results equal GET /read, byte for byte", async () => {
    const direct = await (await fetch(`${base}/read/42161/${TEST}`)).text();
    const stdio = await overStdio(base);
    const http = await overHttp(base);
    try {
      for (const client of [stdio, http.client]) expect((await client.listTools()).tools.map((t) => t.name)).toEqual([READ_TOOL]);
      const args = { name: READ_TOOL, arguments: { chainId: 42161, address: TEST } };
      const viaStdio = await stdio.callTool(args);
      const viaHttp = await http.client.callTool(args);
      expect(viaHttp).toEqual(viaStdio);
      expect(texts(viaStdio)).toEqual(["chain 42161, as of block 518782876", direct]);
      expect(texts(viaHttp)[1]).toBe(direct);
      expect(direct).toBe(BODY);
    } finally {
      await stdio.close();
      await http.stop();
    }
  }, 30_000);

  it("HTTP sends no CORS headers and serves nothing but the MCP path", async () => {
    const http = await overHttp(base);
    try {
      for (const path of ["/", "/metrics", "/stats", "/read/42161/x"]) {
        const r = await fetch(`http://127.0.0.1:${http.port}${path}`, { headers: { origin: "https://example.com" } });
        expect(r.status).toBe(404);
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
      }
      const r = await fetch(`http://127.0.0.1:${http.port}${MCP_PATH}`, { method: "OPTIONS", headers: { origin: "https://example.com" } });
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await http.stop();
    }
  }, 30_000);
});

async function limited(opts: { rateLimitPerMin: number; clientIpHeader?: string }) {
  const server = readHttpServer({ readerUrl: base, ...opts });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${MCP_PATH}`;
  const post = async (i: number, headers: Record<string, string> = {}) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }),
    });
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  };
  return { post, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("HTTP rate limit", () => {
  it("answers 429 with a plain body once an IP exceeds MCP_RATE_LIMIT_PER_MIN in a minute", async () => {
    const s = await limited({ rateLimitPerMin: 3 });
    try {
      const rs = [];
      for (let i = 0; i < 4; i++) rs.push(await s.post(i));
      expect(rs.slice(0, 3).map((r) => r.status)).not.toContain(429);
      expect(rs[3]!.status).toBe(429);
      expect(rs[3]!.type).toMatch(/^text\/plain/);
      expect(rs[3]!.body).toMatch(/rate limit/);
    } finally {
      await s.close();
    }
  });

  it("without MCP_CLIENT_IP_HEADER, spoofed client-IP headers are bucketed by the true peer", async () => {
    const s = await limited({ rateLimitPerMin: 3 });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await s.post(i, { "x-real-ip": `198.51.100.${i}`, "x-forwarded-for": `203.0.113.${i}` })).status);
      expect(statuses[3]).toBe(429);
    } finally {
      await s.close();
    }
  });

  it("with MCP_CLIENT_IP_HEADER=X-Real-IP, the key is that header; a spoofed X-Forwarded-For changes nothing", async () => {
    // The edge overwrites X-Real-IP with the true peer; the client controls X-Forwarded-For.
    const s = await limited({ rateLimitPerMin: 3, clientIpHeader: "X-Real-IP" });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await s.post(i, { "x-real-ip": "192.0.2.7", "x-forwarded-for": `203.0.113.${i}` })).status);
      expect(statuses[3]).toBe(429);
      expect((await s.post(9, { "x-real-ip": "192.0.2.8" })).status).not.toBe(429);
    } finally {
      await s.close();
    }
  });
});

describe("wording", () => {
  const skill = readFileSync(new URL("../../../../skills/read-record/SKILL.md", import.meta.url), "utf8");
  it("the tool description is at most two sentences and uses none of the banned words", () => {
    expect(bannedHits(READ_TOOL_DESCRIPTION)).toEqual([]);
    expect(READ_TOOL_DESCRIPTION.split(/\.\s/).length).toBeLessThanOrEqual(2);
  });
  it("the skill uses none of the banned words outside its own list of them", () => {
    const outside = skill.replace(/<!-- banned:start -->[\s\S]*?<!-- banned:end -->/g, "");
    expect(bannedHits(outside)).toEqual([]);
  });
  it("the skill says nothing indexed, never none, and never labels a payer an agent", () => {
    expect(skill).toContain("nothing indexed");
    expect(skill).not.toMatch(/\bnone\b/i);
    expect(skill).not.toMatch(/\b(?:the|an?) agent paid\b|\bpayer is an agent\b/i);
  });
});
