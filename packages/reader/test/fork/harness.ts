// Fork-test plumbing: anvil, the indexer as a child process, and a table dump. The upstream RPC URL is
// never printed: child output is captured and only shown, redacted, when something fails.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";

export const UPSTREAM = process.env.READER_ARBITRUM_RPC_URL;
export const UPSTREAM_BASE = process.env.READER_BASE_RPC_URL;
export const UPSTREAM_GROUNDING = process.env.READER_ARBITRUM_GROUNDING_RPC_URL;
export const UPSTREAM_BASE_GROUNDING = process.env.READER_BASE_GROUNDING_RPC_URL;

export const TABLES = [
  "record_entries",
  "obligation_pairs",
  "accounts",
  "grants",
  "vaults",
  "vault_fundings",
  "vault_payments",
  "implementation_history",
  "counterparties",
] as const;
/** B4 part 1 tables. */
export const EXTERNAL_TABLES = [
  "factory_accounts",
  "external_permissions",
  "external_payments",
  "external_redemptions",
  "credit_line_events",
  "feedbacks",
  "agent_wallets",
] as const;
export type Tables = Record<(typeof TABLES)[number] | (typeof EXTERNAL_TABLES)[number], Record<string, unknown>[]>;

export function redact(s: string): string {
  let out = s;
  for (const [url, name] of [
    [UPSTREAM, "<READER_ARBITRUM_RPC_URL>"],
    [UPSTREAM_BASE, "<READER_BASE_RPC_URL>"],
    [UPSTREAM_GROUNDING, "<READER_ARBITRUM_GROUNDING_RPC_URL>"],
    [UPSTREAM_BASE_GROUNDING, "<READER_BASE_GROUNDING_RPC_URL>"],
  ] as const) {
    if (!url) continue;
    out = out.split(url).join(name);
    try {
      const host = new URL(url).host;
      if (host) out = out.split(host).join("<rpc-host>");
    } catch {}
  }
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Child = { proc: ChildProcess; output: () => string };

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Child {
  const proc = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  proc.stdout!.on("data", (d) => (buf += d));
  proc.stderr!.on("data", (d) => (buf += d));
  return { proc, output: () => redact(buf) };
}

async function stop(c: Child) {
  if (c.proc.exitCode !== null) return;
  const exited = new Promise((r) => c.proc.once("exit", r));
  c.proc.kill("SIGTERM");
  await Promise.race([exited, sleep(30_000)]);
  if (c.proc.exitCode === null) c.proc.kill("SIGKILL");
}

export type Anvil = { url: string; stop: () => Promise<void> };

export async function startAnvil(forkBlock: number): Promise<Anvil> {
  if (!UPSTREAM) throw new Error("READER_ARBITRUM_RPC_URL unset");
  const port = await freePort();
  const c = run("anvil", ["--fork-url", UPSTREAM, "--fork-block-number", String(forkBlock), "--port", String(port)], process.env);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (c.proc.exitCode !== null) throw new Error(`anvil exited:\n${c.output()}`);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) return { url, stop: () => stop(c) };
    } catch {}
    await sleep(500);
  }
  await stop(c);
  throw new Error(`anvil did not start:\n${c.output()}`);
}

export type IndexRun = { tables: Tables; output: string };

export type IndexOpts = {
  /** Arbitrum RPC (an anvil fork or the upstream), for both roles (src/rpc.ts). */
  rpcUrl?: string;
  /** Base RPC, for both roles. */
  baseRpcUrl?: string;
  /** Base grounding RPC, replacing baseRpcUrl in that role only. */
  baseGroundingRpcUrl?: string;
  startBlock?: number;
  /** READER_END_BLOCK. Unset: the indexer follows the head after the backfill. */
  endBlock?: number;
  cwd?: string;
  /** READER_CHAINS. Default Arbitrum only. */
  chains?: string;
  /** READER_SOURCES. Default the NablaZ sources only, so the Phase 0 replays keep their scope. */
  sources?: string;
  /** Keep the server running after /ready and return its URL; the caller stops it. */
  serve?: boolean;
};

export type Served = IndexRun & { url: string; stop: () => Promise<void>; dir: string };

/**
 * Index from scratch into a fresh PGlite directory, wait for /ready, stop, and dump every table.
 * `cwd` is the reader package directory (default: the current directory).
 */
export async function indexOnce(opts: IndexOpts & { serve?: false }): Promise<IndexRun>;
export async function indexOnce(opts: IndexOpts & { serve: true }): Promise<Served>;
export async function indexOnce(opts: IndexOpts): Promise<IndexRun | Served> {
  const dir = mkdtempSync(join(tmpdir(), "reader-pglite-"));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    READER_PGLITE_DIR: dir,
    READER_CHAINS: opts.chains ?? "42161",
    READER_SOURCES: opts.sources ?? "nabla",
    PONDER_TELEMETRY_DISABLED: "true",
  };
  if (opts.rpcUrl) env.READER_ARBITRUM_RPC_URL = env.READER_ARBITRUM_GROUNDING_RPC_URL = opts.rpcUrl;
  if (opts.baseRpcUrl) env.READER_BASE_RPC_URL = env.READER_BASE_GROUNDING_RPC_URL = opts.baseRpcUrl;
  if (opts.baseGroundingRpcUrl) env.READER_BASE_GROUNDING_RPC_URL = opts.baseGroundingRpcUrl;
  if (opts.endBlock !== undefined) env.READER_END_BLOCK = String(opts.endBlock);
  else delete env.READER_END_BLOCK;
  if (opts.startBlock !== undefined) env.READER_START_BLOCK = String(opts.startBlock);
  else delete env.READER_START_BLOCK;
  const c = run("node_modules/.bin/ponder", ["start", "--schema", "reader", "--port", String(port)], env, opts.cwd);
  try {
    for (let i = 0; ; i++) {
      if (c.proc.exitCode !== null) throw new Error(`indexer exited (${c.proc.exitCode}):\n${c.output()}`);
      if (i > 1800) throw new Error(`indexer not ready after 30 min:\n${c.output()}`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/ready`);
        if (r.status === 200) break;
      } catch {}
      await sleep(1000);
    }
  } catch (e) {
    await stop(c);
    throw e;
  }
  if (opts.serve) {
    const url = `http://127.0.0.1:${port}`;
    return {
      url,
      dir,
      output: c.output(),
      tables: {} as Tables,
      stop: async () => {
        await stop(c);
      },
    };
  }
  await stop(c);
  const output = c.output();
  if (/\bERROR\b/.test(output)) throw new Error(`indexer logged an error:\n${output}`);
  return { tables: await dump(dir), output };
}

/** Stop a served indexer and dump its tables. */
export async function stopAndDump(s: Served): Promise<IndexRun> {
  await s.stop();
  return { tables: await dump(s.dir), output: s.output };
}

async function dump(dir: string): Promise<Tables> {
  const db = new PGlite(dir);
  try {
    const out = {} as Tables;
    for (const t of [...TABLES, ...EXTERNAL_TABLES]) {
      const r = await db.query<Record<string, unknown>>(`SELECT * FROM reader.${t} ORDER BY id`);
      out[t] = r.rows;
    }
    return out;
  } finally {
    await db.close();
  }
}

export type RpcCall = { method: string; params: unknown };
export type CountingProxy = { url: string; calls: RpcCall[]; failing: boolean; stop: () => Promise<void> };

/**
 * A JSON-RPC proxy on 127.0.0.1 that records every call it receives and forwards it to `target`. With `failing`
 * set it answers 503 without forwarding: an RPC that is down.
 */
export async function countingProxy(target: string): Promise<CountingProxy> {
  const port = await freePort();
  const p: CountingProxy = { url: `http://127.0.0.1:${port}`, calls: [], failing: false, stop: async () => {} };
  const srv = createHttpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body) as { method: string; params: unknown } | { method: string; params: unknown }[];
    for (const c of Array.isArray(parsed) ? parsed : [parsed]) p.calls.push({ method: c.method, params: c.params });
    if (p.failing) return res.writeHead(503, { "content-type": "text/plain" }).end("down");
    try {
      const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(await r.text());
    } catch {
      res.writeHead(502, { "content-type": "text/plain" }).end("upstream unreachable");
    }
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  p.stop = () => new Promise<void>((r) => srv.close(() => r()));
  return p;
}
