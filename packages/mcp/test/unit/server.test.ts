// The MCP read server against a local HTTP stub of GET /read: pass-through, reads only, a 4xx as-is and a 5xx as a fixed text,
// the readiness gate on every door (R-S202-4: {"ready":false} until the reader's /ready/head is 200, S213 B1), the stdio and Streamable HTTP entry points (same result, byte for byte), the HTTP front's GET /read relay (below 500 unchanged, /ready not-ready as {"ready":false}, no reader 5xx body), the /mcp catch-all, the HTTP rate limit, and the wording rules (no score, verdict, ranking, trust, reputation or credit-bureau
// wording; "nothing indexed", not "none").

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_READER_URL, READ_TOOL, READ_TOOL_DESCRIPTION, READER_READY_PATH, readServer } from "../../src/server.ts";

/** The reader's readiness with the head gate (S213 B1): what the front asks before any read, and relays as /ready. */
const READY = READER_READY_PATH;
import { MCP_PATH, readHttpServer } from "../../src/http.ts";
import { bannedHits } from "../../../reader/lib/wording.ts";

const TEST = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
// Not the reader's formatting on purpose: the body must come back byte for byte, not re-serialized.
const BODY = `{"subject":"${TEST}",  "chainId":42161,"asOfBlock":"518782876","facts":[],"selfDealing":null,"exposure":null,"notes":["x: nothing indexed (blocks 1..2)"]}`;
const NOT_READ = `{"error":"chain 1 is not read here"}`;
// A reader /feed body, not re-serialized either: relayed byte for byte.
const FEED = `{"asOfBlock":{"42161":"523296543", "8453":"56076154"},"items":[],"nextBefore":null}`;
// The body the hosted reader served on S198 (Ponder's pg statement timeout), path and all.
const UPSTREAM_500 = `error: canceling statement due to statement timeout occurred in '/app/node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:45:11' while handling a 'GET' request to the route '/read/42161/${TEST}'`;
const MAIN = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const NODE_ARGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

let stub: Server;
let base: string;
const seen: string[] = [];
/** The stub's /ready/head: 1 when the index is ready and current with the chain heads, else 0 (200, or 503 with a reader text). */
let isReady = 1;

beforeAll(async () => {
  stub = createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === READY) {
      if (isReady === 1) return res.writeHead(200, { "content-type": "text/plain; charset=UTF-8" }).end("");
      return res.writeHead(503, { "content-type": "text/plain; charset=UTF-8" }).end("Historical indexing is not complete.");
    }
    if (req.url!.startsWith("/feed")) return res.writeHead(200, { "content-type": "application/json" }).end(FEED);
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
    expect(seen).toEqual([READY, `/read/42161/${TEST}`]);
    expect(r.isError).toBeFalsy();
    expect(texts(r)).toEqual(["chain 42161, as of block 518782876", BODY]);
  });

  it("a reader 4xx is reader-authored: an unknown chain gets the API's 404 message, as-is", async () => {
    const client = await connected();
    const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 1, address: TEST } });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual([`GET /read/1/${TEST}: HTTP 404`, NOT_READ]);
  });

  it("the address cannot reach another endpoint", async () => {
    const client = await connected();
    seen.length = 0;
    await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: "../../status" } });
    expect(seen).toEqual([READY, "/read/42161/..%2F..%2Fstatus"]);
  });

  it("a reader that does not answer is an error, not a read with nothing indexed; the caller sees no URL and no fetch text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = await connected("http://127.0.0.1:1");
      const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: TEST } });
      expect(r.isError).toBe(true);
      // Row K (S198 deferred): the loopback URL and the fetch error text are the server's, not the caller's.
      expect(texts(r)).toEqual(["the reader did not answer"]);
      for (const leak of ["127.0.0.1", "http://", "fetch failed", "ECONNREFUSED"]) expect(JSON.stringify(r)).not.toContain(leak);
      // The readiness check is the first call, so it is the one that finds the reader gone.
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/^reader unreachable on GET \/ready\/head: /m);
    } finally {
      log.mockRestore();
    }
  });

  it("a reader 5xx never reaches the caller: a fixed text, the reader's body in the server log only", async () => {
    const reader = createServer((req, res) => (req.url === READY ? res.writeHead(200).end() : res.writeHead(500, { "content-type": "text/plain" }).end(UPSTREAM_500)));
    await new Promise<void>((r) => reader.listen(0, "127.0.0.1", r));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = await connected(`http://127.0.0.1:${(reader.address() as { port: number }).port}`);
      const r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: TEST } });
      expect(r.isError).toBe(true);
      expect(texts(r)).toEqual([`GET /read/42161/${TEST}: HTTP 500`, "reader error (status 500)"]);
      for (const leak of ["/app/", "node_modules", "pg-pool", "statement timeout"]) expect(JSON.stringify(r)).not.toContain(leak);
      expect(log).toHaveBeenCalledWith(`reader 500 on GET /read/42161/${TEST}: ${UPSTREAM_500}`);
    } finally {
      log.mockRestore();
      await new Promise<void>((r) => reader.close(() => r()));
    }
  });
});

describe("readiness gate (R-S202-4)", () => {
  // The S202 public probe: an unready schema served facts [] with an asOfBlock, an empty record that is absence (R-S189-6).
  const EMPTY = `{"subject":"${TEST}","chainId":42161,"asOfBlock":"445102197","facts":[],"selfDealing":null,"exposure":null,"notes":[]}`;
  let reader: Server;
  let readerUrl: string;
  let ready = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    reader = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === READY) return ready === 1 ? res.writeHead(200).end() : res.writeHead(503, { "content-type": "text/plain; charset=UTF-8" }).end("Historical indexing is not complete.");
      res.writeHead(200, { "content-type": "application/json" }).end(EMPTY);
    });
    await new Promise<void>((r) => reader.listen(0, "127.0.0.1", r));
    readerUrl = `http://127.0.0.1:${(reader.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => reader.close(() => r())));

  it("GET /read: 503 {\"ready\":false} and no record while is_ready = 0; the reader's /read is never called. 200 once is_ready = 1", async () => {
    const front = readHttpServer({ readerUrl });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(front.address() as { port: number }).port}/read/42161/${TEST}`;
    try {
      ready = 0;
      hits.length = 0;
      let r = await fetch(url);
      let body = await r.text();
      expect([r.status, r.headers.get("content-type"), body]).toEqual([503, "application/json", `{"ready":false}`]);
      for (const leak of ["facts", "asOfBlock", "Historical"]) expect(body).not.toContain(leak);
      expect(hits).toEqual([READY]);
      ready = 1;
      hits.length = 0;
      r = await fetch(url);
      body = await r.text();
      expect([r.status, body]).toEqual([200, EMPTY]);
      expect(hits).toEqual([READY, `/read/42161/${TEST}`]);
    } finally {
      await new Promise<void>((r) => front.close(() => r()));
    }
  });

  it("read_subject: {\"ready\":false} as an error result, never an empty record, while is_ready = 0; the record once is_ready = 1", async () => {
    const client = await connected(readerUrl);
    ready = 0;
    hits.length = 0;
    let r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: TEST } });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual([`GET /read/42161/${TEST}: HTTP 503`, `{"ready":false}`]);
    for (const leak of ["facts", "asOfBlock", "as of block", "Historical"]) expect(JSON.stringify(r)).not.toContain(leak);
    expect(hits).toEqual([READY]);
    ready = 1;
    hits.length = 0;
    r = await client.callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: TEST } });
    expect(r.isError).toBeFalsy();
    expect(texts(r)).toEqual(["chain 42161, as of block 445102197", EMPTY]);
    expect(hits).toEqual([READY, `/read/42161/${TEST}`]);
  });

  it("GET /feed: 503 {\"ready\":false} and the reader's /feed never called while not ready; once ready, relayed with its query, byte for byte", async () => {
    const front = readHttpServer({ readerUrl });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(front.address() as { port: number }).port}/feed?limit=2&before=MTcwMC44NDUzLjEuMC4y`;
    try {
      ready = 0;
      hits.length = 0;
      let r = await fetch(url);
      expect([r.status, r.headers.get("content-type"), await r.text()]).toEqual([503, "application/json", `{"ready":false}`]);
      expect(hits).toEqual([READY]);
      ready = 1;
      hits.length = 0;
      r = await fetch(url);
      expect([r.status, await r.text()]).toEqual([200, EMPTY]);
      expect(hits).toEqual([READY, "/feed?limit=2&before=MTcwMC44NDUzLjEuMC4y"]);
    } finally {
      await new Promise<void>((r) => front.close(() => r()));
    }
  });

  it("GET /ready is the reader's head-gated readiness (S213 B1): 503 {\"ready\":false}, then 200 with an empty body; Ponder's /ready is never asked", async () => {
    const front = readHttpServer({ readerUrl });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(front.address() as { port: number }).port}/ready`;
    try {
      ready = 0;
      hits.length = 0;
      let r = await fetch(url);
      expect([r.status, r.headers.get("content-type"), await r.text()]).toEqual([503, "application/json", `{"ready":false}`]);
      ready = 1;
      r = await fetch(url);
      expect([r.status, await r.text()]).toEqual([200, ""]);
      expect(hits).toEqual([READY, READY]);
    } finally {
      await new Promise<void>((r) => front.close(() => r()));
    }
  });

  it("a 5xx on /ready is not ready: {\"ready\":false} at both doors, the reader's body in the server log only", async () => {
    const broken = createServer((req, res) => (req.url === READY ? res.writeHead(500, { "content-type": "text/plain" }).end(UPSTREAM_500) : res.writeHead(200, { "content-type": "application/json" }).end(EMPTY)));
    await new Promise<void>((r) => broken.listen(0, "127.0.0.1", r));
    const brokenUrl = `http://127.0.0.1:${(broken.address() as { port: number }).port}`;
    const front = readHttpServer({ readerUrl: brokenUrl });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = await fetch(`http://127.0.0.1:${(front.address() as { port: number }).port}/read/42161/${TEST}`);
      expect([h.status, await h.text()]).toEqual([503, `{"ready":false}`]);
      const m = await (await connected(brokenUrl)).callTool({ name: READ_TOOL, arguments: { chainId: 42161, address: TEST } });
      expect(texts(m)).toEqual([`GET /read/42161/${TEST}: HTTP 503`, `{"ready":false}`]);
      for (const leak of ["/app/", "pg-pool", "statement timeout"]) expect(JSON.stringify(m)).not.toContain(leak);
      expect(log).toHaveBeenCalledWith(`reader 500 on GET /ready/head: ${UPSTREAM_500}`);
    } finally {
      log.mockRestore();
      await new Promise<void>((r) => front.close(() => r()));
      await new Promise<void>((r) => broken.close(() => r()));
    }
  });
});

describe("reads only", () => {
  it("exposes one tool, read-only; no write, signing or payment tool, no prompt, no resource", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([READ_TOOL]);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools[0]!.title).toBe("Read indexed facts about an address");
    expect(tools[0]!.annotations?.title).toBe(tools[0]!.title);
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

  it("HTTP relays a 2xx or 4xx GET /read unchanged (status, content type, body bytes): reader-authored answers", async () => {
    const http = await overHttp(base);
    try {
      for (const path of [`/read/42161/${TEST}`, `/read/1/${TEST}`]) {
        const direct = await fetch(`${base}${path}`);
        const front = await fetch(`http://127.0.0.1:${http.port}${path}`);
        expect([front.status, front.headers.get("content-type")]).toEqual([direct.status, direct.headers.get("content-type")]);
        expect(Buffer.from(await front.arrayBuffer()).equals(Buffer.from(await direct.arrayBuffer()))).toBe(true);
      }
      expect(await (await fetch(`http://127.0.0.1:${http.port}/read/42161/${TEST}`)).text()).toBe(BODY);
      expect(await (await fetch(`http://127.0.0.1:${http.port}/read/1/${TEST}`)).text()).toBe(NOT_READ);
    } finally {
      await http.stop();
    }
  }, 30_000);

  it("HTTP GET /ready not ready: 503 with the front's own {\"ready\":false}, never the reader's body or an error", async () => {
    // Not ready, the stub answers /ready/head with 503 "Historical indexing is not complete." (the reader's text).
    isReady = 0;
    const http = await overHttp(base);
    try {
      const r = await fetch(`http://127.0.0.1:${http.port}/ready`);
      const body = await r.text();
      expect([r.status, r.headers.get("content-type"), body]).toEqual([503, "application/json", `{"ready":false}`]);
      expect(body).not.toContain("Historical");
      expect(body).not.toContain("error");
    } finally {
      isReady = 1;
      await http.stop();
    }
  }, 30_000);

  it("HTTP never relays a reader 5xx body: a filesystem path and the driver text stay in the server log", async () => {
    const UPSTREAM = UPSTREAM_500;
    const reader = createServer((req, res) => (req.url === READY ? res.writeHead(200).end() : res.writeHead(500, { "content-type": "text/plain" }).end(UPSTREAM)));
    await new Promise<void>((r) => reader.listen(0, "127.0.0.1", r));
    const front = readHttpServer({ readerUrl: `http://127.0.0.1:${(reader.address() as { port: number }).port}` });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await fetch(`http://127.0.0.1:${(front.address() as { port: number }).port}/read/42161/${TEST}`);
      const body = await r.text();
      expect([r.status, r.headers.get("content-type"), body]).toEqual([500, "application/json", `{"error":"internal error"}`]);
      for (const leak of ["/app/", "node_modules", "pg-pool", "statement timeout", UPSTREAM]) expect(body).not.toContain(leak);
      expect(log).toHaveBeenCalledWith(`reader 500 on GET /read/42161/${TEST}: ${UPSTREAM}`);
    } finally {
      log.mockRestore();
      await new Promise<void>((r) => front.close(() => r()));
      await new Promise<void>((r) => reader.close(() => r()));
    }
  });

  it("GET /live: 200 while the reader process answers /health, 503 once it does not; index progress plays no part", async () => {
    let up = true;
    const reader = createServer((req, res) => {
      if (req.url === "/health" && up) return res.writeHead(200).end();
      // /ready answers 503 throughout: the index has not caught up, which /live ignores.
      res.writeHead(503).end();
    });
    await new Promise<void>((r) => reader.listen(0, "127.0.0.1", r));
    const http = await overHttp(`http://127.0.0.1:${(reader.address() as { port: number }).port}`);
    try {
      const get = async (p: string) => {
        const r = await fetch(`http://127.0.0.1:${http.port}${p}`);
        return [r.status, await r.text()];
      };
      expect(await get("/live")).toEqual([200, "live\n"]);
      expect((await get("/ready"))[0]).toBe(503);
      up = false;
      expect(await get("/live")).toEqual([503, "reader process not answering\n"]);
      await new Promise<void>((r) => reader.close(() => r()));
      expect(await get("/live")).toEqual([503, "reader process not answering\n"]);
    } finally {
      await http.stop();
      reader.close();
    }
  }, 30_000);

  it("GET /live with the reader's PID: 200 while that process runs, even when its HTTP loop never answers; 503 once it exits", async () => {
    // Row G (R-S194-15): Ponder's event loop can stall on a fat block; deploy health must not restart the machine
    // for that. A reader that accepts connections and never answers stands in for the stalled loop.
    const hung = createServer(() => {});
    await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
    const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const front = readHttpServer({ readerUrl: `http://127.0.0.1:${(hung.address() as { port: number }).port}`, readerPid: proc.pid! });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const live = async () => {
      const r = await fetch(`http://127.0.0.1:${(front.address() as { port: number }).port}/live`, { signal: AbortSignal.timeout(5_000) });
      return [r.status, await r.text()];
    };
    try {
      expect(await live()).toEqual([200, "live\n"]);
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGKILL");
      await exited;
      expect(await live()).toEqual([503, "reader process not running\n"]);
    } finally {
      proc.kill("SIGKILL");
      front.closeAllConnections();
      hung.closeAllConnections();
      await new Promise<void>((r) => front.close(() => r()));
      await new Promise<void>((r) => hung.close(() => r()));
    }
  }, 30_000);

  it("HTTP POST /mcp: a thrown error answers a fixed 500 \"internal error\"; its message and stack go to the server log only", async () => {
    const thrown = new Error("ENOENT: no such file or directory, open '/app/packages/mcp/secret/state.json'");
    const handle = vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockRejectedValue(thrown);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const front = readHttpServer({ readerUrl: base });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    try {
      const r = await fetch(`http://127.0.0.1:${(front.address() as { port: number }).port}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const body = await r.text();
      expect([r.status, body]).toEqual([500, "internal error\n"]);
      for (const leak of ["/app/", "ENOENT", "state.json", thrown.message]) expect(body).not.toContain(leak);
      expect(log.mock.calls.flat().join("\n")).toContain(thrown.stack!);
    } finally {
      handle.mockRestore();
      log.mockRestore();
      await new Promise<void>((r) => front.close(() => r()));
    }
  });

  it("HTTP sends no CORS headers and serves nothing of the reader but /read, /feed and /ready", async () => {
    const http = await overHttp(base);
    try {
      for (const path of ["/", "/metrics", "/metrics/reader", "/stats", "/status", "/health", "/graphql", "/sql/x", "/read", "/read/42161", `/read/42161/${TEST}/x`, "/read/../metrics", READY, "/feed/x", "/feeds"]) {
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
  const skill = readFileSync(new URL("../../../../plugins/nablaz/skills/read-record/SKILL.md", import.meta.url), "utf8");
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
