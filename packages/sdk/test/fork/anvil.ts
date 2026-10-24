// anvil fork for the SDK fork tests. The upstream URL is never printed: output is captured and shown
// only redacted, on failure.

import { spawn } from "node:child_process";
import { createServer } from "node:net";

export const UPSTREAM = process.env.READER_ARB_RPC_URL;
// ≥ 517949578 (the CTO's read of the live TEST account); head was 517955766 when pinned.
export const FORK_BLOCK = 517_955_000;

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

export type Anvil = { url: string; stop: () => Promise<void> };

export async function startAnvil(forkBlock = FORK_BLOCK): Promise<Anvil> {
  if (!UPSTREAM) throw new Error("READER_ARB_RPC_URL unset");
  const port = await freePort();
  const proc = spawn("anvil", ["--fork-url", UPSTREAM, "--fork-block-number", String(forkBlock), "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout!.on("data", (d) => (buf += d));
  proc.stderr!.on("data", (d) => (buf += d));
  const stop = async () => {
    if (proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000)]);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  };
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`anvil exited:\n${redact(buf)}`);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) return { url, stop };
    } catch {}
    await sleep(500);
  }
  await stop();
  throw new Error(`anvil did not start:\n${redact(buf)}`);
}
