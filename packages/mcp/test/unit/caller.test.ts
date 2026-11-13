// P-GTM-4 (R-S214-11, R-S217-7): the front's caller classifier (src/caller.ts) and its wiring at both read doors. The
// header allowlist, an unknown value ignored, the user-agent config, the default "unclassified"; the internal loopback
// headers the reader counts (set by the front, never a caller's copy); one log line per door request, no IP; and every
// answer byte-identical with and without x-nablaz-caller.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CALLER_CLASSES,
  CALLER_HEADER,
  CALLER_VALUES,
  CLASS_HEADER,
  DOOR_HEADER,
  DOORS,
  UA_LOGGED_MAX,
  UA_RULES,
  callerLogLine,
  classify,
  doorOf,
  tagged,
} from "../../src/caller.ts";
import { MCP_PATH, readHttpServer } from "../../src/http.ts";
import { READER_READY_PATH } from "../../src/server.ts";
import * as reader from "../../../reader/src/api/callers.ts";

const TEST = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
const BODY = `{"subject":"${TEST}","chainId":42161,"asOfBlock":"1","facts":[]}`;
const READ_PATH = /^\/read\/[^/]+\/[^/]+$/;

describe("classify", () => {
  it("an allowlisted x-nablaz-caller value is its own class, whatever the user-agent", () => {
    for (const v of CALLER_VALUES) expect(classify({ [CALLER_HEADER]: v, "user-agent": "Bot/1" }, [{ contains: "bot", observed: "t" }])).toBe(v);
    expect([...CALLER_VALUES]).toEqual(["fixture", "ci", "watcher", "cto", "site", "se"]);
  });

  it("any other x-nablaz-caller value is ignored, as if absent", () => {
    for (const v of ["", "FIXTURE", " fixture", "fixture ", "ingester", "unclassified", "admin", "fixture,ci", "cto\n"]) {
      expect(classify({ [CALLER_HEADER]: v })).toBe("unclassified");
      expect(classify({ [CALLER_HEADER]: v, "user-agent": "SomeIngester/2.0" }, [{ contains: "someingester", observed: "t" }])).toBe("ingester");
    }
  });

  it("the user-agent config matches a case-insensitive substring and gives class ingester", () => {
    const rules = [{ contains: "ExampleChecker", observed: "test only" }];
    expect(classify({ "user-agent": "Mozilla/5.0 (compatible; examplechecker/1.2)" }, rules)).toBe("ingester");
    expect(classify({ "user-agent": "EXAMPLECHECKER" }, rules)).toBe("ingester");
    expect(classify({ "user-agent": "Example Checker" }, rules)).toBe("unclassified");
    expect(classify({}, rules)).toBe("unclassified");
    // An empty pattern never matches everything.
    expect(classify({ "user-agent": "anything" }, [{ contains: "", observed: "t" }])).toBe("unclassified");
  });

  it("default: unclassified (no header, no user-agent, or a user-agent no rule names)", () => {
    expect(classify({})).toBe("unclassified");
    expect(classify({ "user-agent": "node" })).toBe("unclassified");
    expect(classify({ "user-agent": "curl/8.5.0" })).toBe("unclassified");
  });

  it("the shipped user-agent config is empty (R-S217-7: entries only from observed log lines, in a later PR)", () => {
    expect(UA_RULES).toEqual([]);
    expect(JSON.parse(readFileSync(new URL("../../src/caller-ua.json", import.meta.url), "utf8"))).toEqual({ ingester: [] });
  });

  it("the reader counts exactly the front's doors and classes (packages/reader/src/api/callers.ts)", () => {
    expect([...reader.DOORS]).toEqual([...DOORS]);
    expect([...reader.CALLER_CLASSES]).toEqual([...CALLER_CLASSES]);
    expect([reader.DOOR_HEADER, reader.CLASS_HEADER]).toEqual([DOOR_HEADER, CLASS_HEADER]);
  });
});

describe("doorOf, callerLogLine, tagged", () => {
  it("only GET /read/* and /mcp are doors; /feed, /ready, /live and the rest are not", () => {
    expect(doorOf("GET", `/read/42161/${TEST}`, READ_PATH, MCP_PATH)).toBe("read");
    expect(doorOf("GET", `/read/42161/${TEST}?x=1`, READ_PATH, MCP_PATH)).toBe("read");
    expect(doorOf("POST", `/read/42161/${TEST}`, READ_PATH, MCP_PATH)).toBeNull();
    expect(doorOf("POST", MCP_PATH, READ_PATH, MCP_PATH)).toBe("mcp");
    expect(doorOf("GET", MCP_PATH, READ_PATH, MCP_PATH)).toBe("mcp");
    for (const p of ["/feed", "/ready", "/live", "/", "/favicon.ico", "/.well-known/agent-registration.json"]) expect(doorOf("GET", p, READ_PATH, MCP_PATH)).toBeNull();
  });

  it("the log line holds time, door, class, status and a truncated user-agent; nothing else", () => {
    const line = callerLogLine("read", "unclassified", 200, "x".repeat(500), new Date("2026-11-13T00:00:00Z"));
    expect(line.startsWith("caller ")).toBe(true);
    const o = JSON.parse(line.slice(7));
    expect(Object.keys(o)).toEqual(["t", "door", "class", "status", "ua"]);
    expect(o).toEqual({ t: "2026-11-13T00:00:00.000Z", door: "read", class: "unclassified", status: 200, ua: "x".repeat(UA_LOGGED_MAX) });
    // A user-agent cannot break the line: JSON escapes it.
    expect(callerLogLine("mcp", "se", "aborted", "a\nb").split("\n")).toHaveLength(1);
  });

  it("tagged sets the internal headers, overriding any of the same name, and keeps the others", async () => {
    const seen: Headers[] = [];
    const get = (async (_u: unknown, init?: RequestInit) => (seen.push(new Headers(init?.headers)), new Response("ok"))) as typeof fetch;
    await tagged(get, "mcp", "cto")("http://127.0.0.1/x", { headers: { [DOOR_HEADER]: "read", [CLASS_HEADER]: "se", accept: "a/b" } });
    await tagged(get, "read", "unclassified")("http://127.0.0.1/y");
    expect([seen[0]!.get(DOOR_HEADER), seen[0]!.get(CLASS_HEADER), seen[0]!.get("accept")]).toEqual(["mcp", "cto", "a/b"]);
    expect([seen[1]!.get(DOOR_HEADER), seen[1]!.get(CLASS_HEADER)]).toEqual(["read", "unclassified"]);
  });
});

describe("both doors, through the front", () => {
  let stub: Server;
  let base: string;
  let ready = true;
  const hits: { url: string; headers: IncomingHttpHeaders }[] = [];
  beforeAll(async () => {
    stub = createServer((req, res) => {
      hits.push({ url: req.url!, headers: req.headers });
      if (req.url === READER_READY_PATH) return ready ? res.writeHead(200, { "content-type": "text/plain" }).end("") : res.writeHead(503).end("not yet");
      res.writeHead(200, { "content-type": "application/json" }).end(BODY);
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => stub.close(() => r())));
  afterEach(() => {
    hits.length = 0;
    ready = true;
    vi.restoreAllMocks();
  });

  async function front(opts: { rateLimitPerMin?: number } = {}) {
    const s = readHttpServer({ readerUrl: base, ...opts });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
  }
  const tags = () => hits.map((h) => [h.url, h.headers[DOOR_HEADER], h.headers[CLASS_HEADER]]);
  type Line = { t: string; door: string; class: string; status: number | "aborted"; ua: string };
  const callerLines = (log: { mock: { calls: unknown[][] } }): Line[] =>
    log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("caller ")).map((l) => JSON.parse(l.slice(7)) as Line);
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("GET /read: the readiness check and the relay carry door read and the class; a caller's internal headers are not forwarded", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await front();
    try {
      await (await fetch(`${f.url}/read/42161/${TEST}`, { headers: { [CALLER_HEADER]: "fixture", [DOOR_HEADER]: "mcp", [CLASS_HEADER]: "cto", "user-agent": "probe/1" } })).text();
      await (await fetch(`${f.url}/read/42161/${TEST}`, { headers: { "user-agent": "outside/1" } })).text();
      expect(tags()).toEqual([
        [READER_READY_PATH, "read", "fixture"],
        [`/read/42161/${TEST}`, "read", "fixture"],
        [READER_READY_PATH, "read", "unclassified"],
        [`/read/42161/${TEST}`, "read", "unclassified"],
      ]);
      await settle();
      const lines = callerLines(log);
      expect(lines.map((l) => [l.door, l.class, l.status, l.ua])).toEqual([
        ["read", "fixture", 200, "probe/1"],
        ["read", "unclassified", 200, "outside/1"],
      ]);
      // No IP anywhere in the line.
      for (const l of log.mock.calls.map((c) => String(c[0])).filter((x) => x.startsWith("caller "))) expect(l).not.toMatch(/127\.0\.0\.1|::1|"ip"/);
    } finally {
      await f.close();
    }
  });

  it("GET /read while not ready: still 503 {\"ready\":false}, one tagged attempt, nothing read", async () => {
    ready = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await front();
    try {
      const r = await fetch(`${f.url}/read/42161/${TEST}`, { headers: { [CALLER_HEADER]: "watcher" } });
      expect([r.status, r.headers.get("content-type"), await r.text()]).toEqual([503, "application/json", `{"ready":false}`]);
      expect(tags()).toEqual([[READER_READY_PATH, "read", "watcher"]]);
    } finally {
      await f.close();
    }
  });

  it("POST /mcp read_subject: the readiness check and the read carry door mcp; discovery calls reach no reader but are logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await front();
    const client = new Client({ name: "test", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${f.url}${MCP_PATH}`), { requestInit: { headers: { [CALLER_HEADER]: "se", "user-agent": "se-probe" } } }));
      await client.listTools();
      expect(hits).toEqual([]);
      await client.callTool({ name: "read_subject", arguments: { chainId: 42161, address: TEST } });
      expect(tags()).toEqual([
        [READER_READY_PATH, "mcp", "se"],
        [`/read/42161/${encodeURIComponent(TEST)}`, "mcp", "se"],
      ]);
      await settle();
      const lines = callerLines(log);
      expect(lines.length).toBeGreaterThanOrEqual(3); // initialize, notifications/initialized, tools/list, tools/call
      expect(new Set(lines.map((l) => `${l.door} ${l.class} ${l.ua}`))).toEqual(new Set(["mcp se se-probe"]));
    } finally {
      await client.close();
      await f.close();
    }
  });

  it("a 429 at a door is logged with its class; it reaches no reader", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await front({ rateLimitPerMin: 1 });
    try {
      await (await fetch(`${f.url}/read/42161/${TEST}`)).text();
      hits.length = 0;
      const r = await fetch(`${f.url}/read/42161/${TEST}`, { headers: { [CALLER_HEADER]: "ci" } });
      expect(r.status).toBe(429);
      await r.text();
      expect(hits).toEqual([]);
      await settle();
      expect(callerLines(log).map((l) => [l.class, l.status])).toEqual([
        ["unclassified", 200],
        ["ci", 429],
      ]);
    } finally {
      await f.close();
    }
  });

  it("non-door paths log nothing and send no internal headers (/ready, /feed, /live)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await front();
    try {
      for (const p of ["/ready", "/feed", "/live", "/nope"]) await (await fetch(`${f.url}${p}`, { headers: { [CALLER_HEADER]: "cto" } })).text();
      await settle();
      expect(callerLines(log)).toEqual([]);
      for (const h of hits) expect([h.headers[DOOR_HEADER], h.headers[CLASS_HEADER]]).toEqual([undefined, undefined]);
    } finally {
      await f.close();
    }
  });

  it("every door answer is byte-identical with and without x-nablaz-caller (status, content type, body)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await front();
    const answer = async (h: Record<string, string>) => {
      const r = await fetch(`${f.url}/read/42161/${TEST}`, { headers: h });
      return [r.status, r.headers.get("content-type"), await r.text(), [...r.headers.keys()].filter((k) => k !== "date").sort()];
    };
    try {
      const plain = await answer({});
      expect(plain[2]).toBe(BODY);
      for (const v of [...CALLER_VALUES, "bogus"]) expect(await answer({ [CALLER_HEADER]: v })).toEqual(plain);
      ready = false;
      const notReady = await answer({});
      expect(await answer({ [CALLER_HEADER]: "cto" })).toEqual(notReady);
    } finally {
      await f.close();
    }
  });
});
