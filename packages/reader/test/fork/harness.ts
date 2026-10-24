// Fork-test plumbing: anvil, the indexer as a child process, and a table dump. The upstream RPC URL is
// never printed: child output is captured and only shown, redacted, when something fails.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";

export const UPSTREAM = process.env.READER_ARB_RPC_URL;

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
export type Tables = Record<(typeof TABLES)[number], Record<string, unknown>[]>;

export function redact(s: string): string {
  if (!UPSTREAM) return s;
  let out = s.split(UPSTREAM).join("<READER_ARB_RPC_URL>");
  try {
    const host = new URL(UPSTREAM).host;
    if (host) out = out.split(host).join("<rpc-host>");
  } catch {}
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

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Child {
  const proc = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
  if (!UPSTREAM) throw new Error("READER_ARB_RPC_URL unset");
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

/** Index from scratch into a fresh PGlite directory, wait for /ready, stop, and dump every table. */
export async function indexOnce(opts: { rpcUrl: string; startBlock?: number; endBlock: number }): Promise<IndexRun> {
  const dir = mkdtempSync(join(tmpdir(), "reader-pglite-"));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    READER_ARB_RPC_URL: opts.rpcUrl,
    READER_PGLITE_DIR: dir,
    READER_END_BLOCK: String(opts.endBlock),
    PONDER_TELEMETRY_DISABLED: "true",
  };
  if (opts.startBlock !== undefined) env.READER_START_BLOCK = String(opts.startBlock);
  else delete env.READER_START_BLOCK;
  const c = run("node_modules/.bin/ponder", ["start", "--schema", "reader", "--port", String(port)], env);
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
  } finally {
    await stop(c);
  }
  const output = c.output();
  if (/\bERROR\b/.test(output)) throw new Error(`indexer logged an error:\n${output}`);
  return { tables: await dump(dir), output };
}

async function dump(dir: string): Promise<Tables> {
  const db = new PGlite(dir);
  try {
    const out = {} as Tables;
    for (const t of TABLES) {
      const r = await db.query<Record<string, unknown>>(`SELECT * FROM reader.${t} ORDER BY id`);
      out[t] = r.rows;
    }
    return out;
  } finally {
    await db.close();
  }
}
