// R-S211-1: at startup an AUTH-class failure (HTTP 401/403) on any configured RPC leg fails the start, naming the leg
// by env name; every other failure keeps warn-and-start (R-S200-2). The detail shape comes from the real
// checkRpcLegs (src/rpc-check.ts), so a change to its wording fails here, not silently in production.

import { describe, expect, it } from "vitest";
import { enabledChains } from "../../src/chains.ts";
import { checkRpcLegs } from "../../src/rpc-check.ts";
import { authFailureMessage, authStatus } from "../../lib/rpc-auth.ts";

const chains = enabledChains();
const env = Object.fromEntries(chains.flatMap((c) => [[c.rpcEnv, `https://ix-${c.name}.example/v2/KEYSECRET`], [c.groundingRpcEnv, `https://gr-${c.name}.example/v2/KEYSECRET`]]));
const ok = (id: number) => (method: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? `0x${id.toString(16)}` : "0x10" }));

/** Every leg answers, except the ones `fail` maps to a Response or a thrown error. */
const post = (fail: (url: string) => Response | Error | undefined) => async (url: string, body: string) => {
  const f = fail(url);
  if (f instanceof Error) throw f;
  if (f) return f;
  const id = chains.find((c) => url.includes(`-${c.name}.`))!.chainId;
  return ok(id)(JSON.parse(body).method);
};

describe("R-S211-1 auth-class startup failure", () => {
  it.each([401, 403])("HTTP %i on a grounding leg is fatal and names that leg's env variable", async (status) => {
    const c = chains[0]!;
    const results = await checkRpcLegs(chains, env, post((u) => (u.startsWith(`https://gr-${c.name}.`) ? new Response("Must be authenticated!", { status }) : undefined)));
    const bad = results.filter((r) => !r.ok);
    expect(bad.map((r) => r.env)).toEqual([c.groundingRpcEnv]);
    expect(authStatus(bad[0]!)).toBe(status);
    const msg = authFailureMessage(results)!;
    expect(msg).toContain(`${c.groundingRpcEnv} (${c.name} grounding, host gr-${c.name}.example): HTTP ${status}`);
    expect(msg).toMatch(/^rpc check FATAL \(R-S211-1\)/);
    expect(msg).not.toContain("KEYSECRET");
  });

  it("every refused leg is named, indexer and grounding", async () => {
    const results = await checkRpcLegs(chains, env, post(() => new Response("", { status: 401 })));
    const msg = authFailureMessage(results)!;
    for (const c of chains) for (const name of [c.rpcEnv, c.groundingRpcEnv]) expect(msg).toContain(`${name} (`);
  });

  it.each([
    ["HTTP 429", () => new Response("", { status: 429 })],
    ["HTTP 500", () => new Response("", { status: 500 })],
    ["HTTP 503", () => new Response("", { status: 503 })],
    ["a connection error", () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })],
    ["a timeout", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["a JSON-RPC error inside HTTP 200", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unauthorized" } }))],
  ] as const)("%s stays warn-and-start (R-S200-2 unchanged)", async (_, make) => {
    const c = chains[0]!;
    const results = await checkRpcLegs(chains, env, post((u) => (u.startsWith(`https://gr-${c.name}.`) ? (make() as Response | Error) : undefined)));
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(authFailureMessage(results)).toBeNull();
  });

  it("an unset leg is not an auth failure", async () => {
    const c = chains[0]!;
    const results = await checkRpcLegs(chains, { ...env, [c.groundingRpcEnv]: undefined }, post(() => undefined));
    expect(authFailureMessage(results)).toBeNull();
  });

  it("all legs healthy: no fatal line", async () => {
    expect(authFailureMessage(await checkRpcLegs(chains, env, post(() => undefined)))).toBeNull();
  });
});

describe("scripts/check-rpc.ts, end to end (the start path in scripts/reader-start.sh)", () => {
  /** Runs the script against a local server: each leg is `<server>/<env name>`; `status(env)` picks the answer. */
  async function runCheck(status: (envName: string) => number) {
    const { createServer } = await import("node:http");
    const { spawn } = await import("node:child_process");
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const name = req.url!.slice(1);
        const s = status(name);
        if (s !== 200) return res.writeHead(s).end("Must be authenticated!");
        const c = chains.find((x) => x.rpcEnv === name || x.groundingRpcEnv === name)!;
        const method = JSON.parse(body).method;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? `0x${c.chainId.toString(16)}` : "0x10" }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const legs = Object.fromEntries(chains.flatMap((c) => [c.rpcEnv, c.groundingRpcEnv].map((n) => [n, `http://127.0.0.1:${port}/${n}`])));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/check-rpc.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { PATH: process.env.PATH!, ...legs },
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    srv.close();
    return { code, err };
  }

  it("a 401 leg exits 78 with the named fatal line", async () => {
    const g = chains[0]!.groundingRpcEnv;
    const { code, err } = await runCheck((n) => (n === g ? 401 : 200));
    expect(code).toBe(78);
    expect(err).toContain(`rpc check FATAL (R-S211-1): 1 leg(s) refused authentication: ${g} (`);
    expect(err).not.toContain("starting anyway");
  }, 60_000);

  it("a 503 leg warns and exits 0", async () => {
    const g = chains[0]!.groundingRpcEnv;
    const { code, err } = await runCheck((n) => (n === g ? 503 : 200));
    expect(code).toBe(0);
    expect(err).toContain(`rpc check WARNING: 1 of ${chains.length * 2} legs failed: ${g}; starting anyway`);
    expect(err).not.toContain("FATAL");
  }, 60_000);
});
