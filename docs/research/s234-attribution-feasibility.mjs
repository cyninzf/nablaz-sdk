#!/usr/bin/env node
// S234 attribution feasibility (R-S234-2): read-only. Re-runnable; the committed figures are in
// s234-attribution-feasibility.md beside it. Nothing here builds, deploys, or changes an env or a flag.
//
//   node docs/research/s234-attribution-feasibility.mjs            from the repo root: all of it, in order:
//       rail     RPC reads on Base (the env name of CHAINS[8453].rpcEnv in packages/reader/src/chains.ts): the ERC-8004 Identity Registry at the address derived from
//                erc-8004/erc-8004-contracts README.md (fetched, never typed in), its bytecode and interface, the
//                Registered event shape and the registration total; the x402 contracts on Base.
//       join     a throwaway Fly console (the docs/measurements/s233-record-size.mjs form) runs `--inside`: SQL in ONE
//                READ ONLY, REPEATABLE READ transaction on the live schema, light form (see inside()); reader health
//                (/ready, /feed?limit=1) before and after; then lists machines and fails unless
//                exactly ONE remains.
//       resolve  the registration-file resolvable rate on the overlap agentIds (tokenURI at the latest block, the
//                file fetched, each http(s) service endpoint probed with one GET).
//       registry the same rate on an evenly spaced registry-wide sample (rail only; NOT the overlap set).
//       x402     facilitator signers from each facilitator's own GET /supported (the facilitators named in
//                coinbase/x402 docs/dev-tools/facilitators.md), matched against Base USDC AuthorizationUsed senders in
//                a recent window, and against the senders of a sample of our own 8453 payment facts.
//   node docs/research/s234-attribution-feasibility.mjs --inside   inside the console: prints the join's figures.
//
// Outbound HTTP (registration files, endpoints, facilitators) sends a generic User-Agent and nothing else.

import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "nablaz-reader";
const CHAIN = 8453;
const UA = "s234-feasibility-read/1";
const ERC8004_REPO = "erc-8004/erc-8004-contracts";
const X402_REPO = "coinbase/x402";
const SAMPLE = 300; // resolve-sample cap, and the own-payments tx sample
const X402_WINDOW = 1800; // blocks (~1 h on Base at 2 s)


// ───────────────────────────── outside ─────────────────────────────

async function outside() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const req = createRequire(path.join(repo, "packages/reader/package.json"));
  const viem = req("viem");
  // The env name comes from packages/reader/src/chains.ts (CHAINS[8453].rpcEnv), never written out here.
  const rpcEnv = execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e",
    `const { CHAINS } = await import(${JSON.stringify(path.join(repo, "packages/reader/src/chains.ts"))}); process.stdout.write(CHAINS[${CHAIN}].rpcEnv);`]).toString();
  const rpcUrl = process.env[rpcEnv];
  if (!rpcUrl) throw new Error(`${rpcEnv} is not set`);
  const rpc = rpcClient(rpcUrl);
  const startedAt = new Date().toISOString();
  console.log(`s234 feasibility read at ${startedAt}`);

  // --parts rail,join,resolve,registry,x402 (default: all) runs a subset; resolve needs join.
  const parts = new Set((process.argv.find((a) => a.startsWith("--parts="))?.slice(8) ?? "rail,join,resolve,registry,x402").split(","));
  const rail = parts.has("rail") ? await railRead(viem, rpc) : null;
  const join = parts.has("join") ? await joinRead() : null;
  const resolve = parts.has("resolve") && join && !join.cut ? await resolveRead(viem, rpc, join) : null;
  const registry = parts.has("registry") && rail ? await resolveRead(viem, rpc, null, rail.registrations) : null;
  const x402 = parts.has("x402") ? await x402Read(viem, rpc, join) : null;
  console.log(`\nJSON-SUMMARY ${JSON.stringify({ startedAt, rail, join: join && { ...join, overlapAgentIds: undefined, paymentTxSample: undefined }, resolve, registry, x402 })}`);
}

function rpcClient(url) {
  let id = 0;
  const one = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = await r.json().catch(() => null);
      if (j && !j.error) return j.result;
      if (j?.error && !/rate|limit|exceed|timeout/i.test(j.error.message ?? "") ) return { __error: j.error };
      if (attempt >= 5) throw new Error(`${method}: ${JSON.stringify(j?.error ?? r.status)}`);
      await new Promise((s) => setTimeout(s, 500 * 2 ** attempt));
    }
  };
  return one;
}

const gh = async (repo, ref, file) => {
  const r = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${file}`, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`${repo}@${ref}:${file}: ${r.status}`);
  return r.text();
};
const headOf = async (repo) => {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, { headers: { "user-agent": UA, accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(`${repo} HEAD: ${r.status}`);
  return (await r.json()).sha;
};

async function railRead(viem, rpc) {
  console.log(`\n== A1/A2 rail: ERC-8004 Identity Registry on ${CHAIN}`);
  const chainId = Number(await rpc("eth_chainId", []));
  if (chainId !== CHAIN) throw new Error(`RPC chain ${chainId}, expected ${CHAIN}`);
  const vendorRef = await headOf(ERC8004_REPO);
  const readme = await gh(ERC8004_REPO, vendorRef, "README.md");
  // The README's "#### Base Mainnet" block, its IdentityRegistry line.
  const block = /#### Base Mainnet\s*\n([\s\S]*?)(?=\n####|\n##|$)/.exec(readme)?.[1] ?? "";
  const addr = /\*\*IdentityRegistry\*\*: \[`(0x[0-9a-fA-F]{40})`\]/.exec(block)?.[1];
  if (!addr) throw new Error("README: no Base Mainnet IdentityRegistry line");
  const registry = viem.getAddress(addr);
  const pinned = (await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/reader/src/generated/erc8004.json"), { with: { type: "json" } })).default;
  const pinnedAddr = pinned.chains[String(CHAIN)].IdentityRegistry;
  console.log(`   derived from ${ERC8004_REPO}@${vendorRef} README.md "Base Mainnet": ${registry}`);
  console.log(`   reader's pinned copy (src/generated/erc8004.json, vendor ${pinned.source.vendor.commit}): ${pinnedAddr} ${viem.isAddressEqual(pinnedAddr, registry) ? "(equal)" : "(DIFFERS)"}`);

  const latest = BigInt(await rpc("eth_blockNumber", []));
  const code = await rpc("eth_getCode", [registry, "latest"]);
  const implSlot = await rpc("eth_getStorageAt", [registry, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"]);
  const impl = viem.getAddress(`0x${implSlot.slice(-40)}`);
  const implCode = await rpc("eth_getCode", [impl, "latest"]);
  const abi = viem.parseAbi([
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function getVersion() view returns (string)",
    "function supportsInterface(bytes4) view returns (bool)",
    "function ownerOf(uint256) view returns (address)",
    "function tokenURI(uint256) view returns (string)",
    "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  ]);
  const call = async (fn, args = [], at = "latest") => {
    const r = await rpc("eth_call", [{ to: registry, data: viem.encodeFunctionData({ abi, functionName: fn, args }) }, at]);
    if (r?.__error) return { error: r.__error.message };
    try { return viem.decodeFunctionResult({ abi, functionName: fn, data: r }); } catch (e) { return { error: String(e.message ?? e).split("\n")[0] }; }
  };
  const iface = {
    name: await call("name"),
    symbol: await call("symbol"),
    version: await call("getVersion"),
    erc721: await call("supportsInterface", ["0x80ac58cd"]),
    erc721Metadata: await call("supportsInterface", ["0x5b5e139f"]),
  };
  console.log(`   at block ${latest}: proxy code ${(code.length - 2) / 2} bytes; EIP-1967 implementation ${impl} (${(implCode.length - 2) / 2} bytes)`);
  console.log(`   name ${JSON.stringify(iface.name)} symbol ${JSON.stringify(iface.symbol)} getVersion ${JSON.stringify(iface.version)} ERC-721 ${iface.erc721} ERC-721Metadata ${iface.erc721Metadata}`);

  // Registered: topic0 from the vendor ABI's signature; the newest one found walking back from the head.
  const vendorAbi = JSON.parse(await gh(ERC8004_REPO, vendorRef, "abis/IdentityRegistry.json"));
  const items = Array.isArray(vendorAbi) ? vendorAbi : vendorAbi.abi;
  const reg = items.find((x) => x.type === "event" && x.name === "Registered");
  const shape = `Registered(${reg.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
  const topic0 = viem.toEventSelector(`${reg.name}(${reg.inputs.map((i) => i.type).join(",")})`);
  console.log(`   event shape (vendor ABI): ${shape}; topic0 ${topic0}`);
  let newest = null;
  for (let hi = latest, span = 2000n; hi > 0n && !newest; hi -= span, span *= 2n) {
    const lo = hi - span + 1n > 0n ? hi - span + 1n : 0n;
    const logs = await rpc("eth_getLogs", [{ address: registry, topics: [topic0], fromBlock: viem.toHex(lo), toBlock: viem.toHex(hi) }]);
    if (Array.isArray(logs) && logs.length) newest = logs.at(-1);
    if (logs?.__error) span /= 4n;
  }
  const dec = viem.decodeEventLog({ abi, data: newest.data, topics: newest.topics });
  const lastId = dec.args.agentId;
  const ownerLast = await call("ownerOf", [lastId], newest.blockNumber);
  const ownerNext = await call("ownerOf", [lastId + 1n], newest.blockNumber);
  // Registrations in the newest window (URI availability at registration, a stated window).
  const winLogs = await rpc("eth_getLogs", [{ address: registry, topics: [topic0], fromBlock: viem.toHex(latest - 1799n), toBlock: viem.toHex(latest) }]);
  const win = (Array.isArray(winLogs) ? winLogs : []).map((l) => viem.decodeEventLog({ abi, data: l.data, topics: l.topics }).args);
  const scheme = (u) => (!u ? "empty" : /^data:/i.test(u) ? "data:" : /^ipfs:\/\//i.test(u) ? "ipfs://" : /^https:\/\//i.test(u) ? "https://" : /^http:\/\//i.test(u) ? "http://" : /^ar:\/\//i.test(u) ? "ar://" : "other");
  const winSchemes = tally(win.map((a) => scheme(a.agentURI)));
  console.log(`   newest Registered: agentId ${lastId} at block ${BigInt(newest.blockNumber)} (tx ${newest.transactionHash})`);
  console.log(`   agentIds are sequential from 0 (IdentityRegistryUpgradeable: agentId = $._lastId++): registrations to block ${BigInt(newest.blockNumber)} = ${lastId + 1n}`);
  console.log(`   check at that block: ownerOf(${lastId}) ${JSON.stringify(ownerLast)}; ownerOf(${lastId + 1n}) ${JSON.stringify(ownerNext)} (expected: reverts, not yet minted)`);
  console.log(`   Registered in the last 1,800 blocks (~1 h): ${win.length}; agentURI at registration by scheme ${JSON.stringify(winSchemes)}`);
  return {
    vendorRef, registry, pinnedEqual: viem.isAddressEqual(pinnedAddr, registry), block: String(latest), proxyBytes: (code.length - 2) / 2, impl, implBytes: (implCode.length - 2) / 2,
    iface: JSON.parse(JSON.stringify(iface, (_, v) => (typeof v === "bigint" ? String(v) : v))), shape, topic0,
    newestRegistered: { agentId: String(lastId), block: String(BigInt(newest.blockNumber)), tx: newest.transactionHash }, registrations: String(lastId + 1n),
    ownerNextReverts: !!ownerNext?.error, window1h: { registered: win.length, schemes: winSchemes },
  };
}

function tally(xs) {
  const m = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

const READER = "https://nablaz-reader.fly.dev";
async function health(label) {
  const r = {};
  for (const p of ["/ready", "/feed?limit=1"]) {
    const t = Date.now();
    const g = await get(`${READER}${p}`, { json: true, timeoutMs: 15000 });
    r[p] = { status: g.status || g.error, ms: Date.now() - t, ...(p.startsWith("/feed") ? { items: (() => { try { return JSON.parse(g.body).items.length; } catch { return null; } })() } : {}) };
  }
  console.log(`   reader health ${label}: ${JSON.stringify(r)}`);
  return r;
}

async function joinRead() {
  console.log(`\n== A3 join: our 8453 subjects × ERC-8004 bound addresses (throwaway Fly console, read-only SQL, no-join form)`);
  const flyctl = path.join(homedir(), ".fly/bin/flyctl");
  const self = fileURLToPath(import.meta.url);
  const healthBefore = await health("before");
  const before = JSON.parse(execFileSync(flyctl, ["machines", "list", "-a", APP, "--json"]).toString());
  console.log(`   machines before console: ${before.length} (${before.map((m) => `${m.id} ${m.state}`).join(", ")})`);
  if (before.length !== 1) { console.error("expected exactly ONE machine before the console; STOP and report"); process.exit(3); }
  let out = "";
  const started = new Date().toISOString();
  const child = spawn(flyctl, ["console", "-a", APP, "--vm-size", "shared-cpu-1x", "--vm-memory", "1024", "--file-local", `/tmp/s234.mjs=${self}`, "-C", "node --max-old-space-size=768 /tmp/s234.mjs --inside"], { stdio: ["ignore", "pipe", "inherit"] });
  let partial = ""; // echo whole lines only: the JOIN-JSON line spans many stdout chunks
  child.stdout.on("data", (b) => {
    const s = b.toString().replace(/(postgres(ql)?|https?|wss?):\/\/[^"\s]+/g, "[url]");
    out += s;
    const lines = (partial + s).split("\n");
    partial = lines.pop();
    for (const line of lines) if (line && !line.startsWith("JOIN-JSON ")) process.stdout.write(`${line}\n`);
  });
  const code = await new Promise((r) => child.on("close", r));
  const ended = new Date().toISOString();
  const machines = JSON.parse(execFileSync(flyctl, ["machines", "list", "-a", APP, "--json"]).toString());
  console.log(`   machines after console: ${machines.length} (${machines.map((m) => `${m.id} ${m.state}`).join(", ")})`);
  const healthAfter = await health("after");
  if (machines.length !== 1) { console.error("expected exactly ONE machine after the console; STOP and report"); process.exit(3); }
  const line = out.split("\n").find((l) => l.startsWith("JOIN-JSON "));
  if (!line) {
    // The CTO stop rule (S234): a cut session ends the DB lane; the run goes on to §B and reports A3/A4 not measured.
    console.log(`   DB LANE STOPPED: console exited ${code} without a JOIN-JSON line (${started}..${ended}); A3/A4 not measured`);
    return { cut: { started, ended, exit: code }, healthBefore, healthAfter };
  }
  return { ...JSON.parse(line.slice("JOIN-JSON ".length)), healthBefore, healthAfter };
}

// A deterministic sample: the n smallest by a hash of the id (stable across runs for the same population).
function sampleOf(ids, n, viem) {
  if (ids.length <= n) return [...ids];
  return [...ids].sort((a, b) => (viem.keccak256(viem.toHex(String(a))) < viem.keccak256(viem.toHex(String(b))) ? -1 : 1)).slice(0, n);
}

async function pool(items, n, f) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k], k); } }));
  return out;
}

async function get(url, { json = false, timeoutMs = 10000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: json ? "application/json" : "*/*" }, signal: ctl.signal, redirect: "follow" });
    const body = json ? await r.text().then((s) => s.slice(0, 1_000_000)) : (r.body?.cancel(), "");
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, error: e.name === "AbortError" ? "timeout" : String(e.cause?.code ?? e.message ?? e) };
  } finally { clearTimeout(t); }
}

const REG_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
const liveStatus = (s) => s >= 200 && s < 500 && s !== 404 && s !== 410;

async function resolveRead(viem, rpc, join, registryWide = null) {
  let ids, sample;
  if (registryWide) {
    // Rail only, no DB: SAMPLE agentIds evenly spaced over [0, registrations), the stated population. NOT the overlap set.
    console.log(`\n== A2/A4 registry-wide: URI availability and resolvable rate on an evenly spaced sample (rail only; NOT the overlap set)`);
    const total = BigInt(registryWide);
    ids = [];
    sample = Array.from({ length: SAMPLE }, (_, i) => (total * BigInt(i)) / BigInt(SAMPLE) + BigInt(i % 7));
    console.log(`   population: all ${total} registered agentIds; sample ${sample.length}: floor(i·N/${SAMPLE}) + (i mod 7), i = 0..${SAMPLE - 1}`);
  } else {
    console.log(`\n== A4 placeholder guard: registration-file resolvable rate`);
    ids = join.overlapAgentIds.map(BigInt);
    sample = sampleOf(ids, SAMPLE, viem);
    if (join.overlapAgentIdCount > ids.length) console.log(`   (the console sent ${ids.length} of ${join.overlapAgentIdCount}: every k-th of the sorted list)`);
    console.log(`   population: ${join.overlapAgentIdCount} agentIds bound (agentWallet or owner, ever) to an overlap subject; ${sample.length === ids.length ? "all read" : `a deterministic sample of ${sample.length} read (smallest keccak(agentId))`}`);
  }
  if (!sample.length) return { population: 0, read: 0 };
  const abi = viem.parseAbi(["function tokenURI(uint256) view returns (string)"]);
  const registry = (await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/reader/src/generated/erc8004.json"), { with: { type: "json" } })).default.chains[String(CHAIN)].IdentityRegistry;
  const rows = await pool(sample, 6, async (id) => {
    const r = await rpc("eth_call", [{ to: registry, data: viem.encodeFunctionData({ abi, functionName: "tokenURI", args: [id] }) }, "latest"]);
    const uri = r?.__error ? null : viem.decodeFunctionResult({ abi, functionName: "tokenURI", data: r });
    const row = { agentId: String(id), scheme: uri === null ? "call-reverted" : !uri ? "empty" : (/^([a-z0-9+.-]+):/i.exec(uri)?.[1]?.toLowerCase() ?? "other") };
    if (!uri) return { ...row, fetched: false };
    row.uriHost = /^https?:\/\/([^/:?#]+)/i.exec(uri)?.[1]?.toLowerCase() ?? row.scheme;
    let text = null;
    if (/^data:/i.test(uri)) {
      const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(uri);
      text = m ? (m[2] ? Buffer.from(m[3], "base64").toString("utf8") : decodeURIComponent(m[3])) : null;
    } else {
      const url = /^ipfs:\/\//i.test(uri) ? `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, "")}` : /^ar:\/\//i.test(uri) ? `https://arweave.net/${uri.slice(5)}` : /^https?:\/\//i.test(uri) ? uri : null;
      if (url) { const g = await get(url, { json: true, timeoutMs: 15000 }); row.fileStatus = g.status || g.error; text = g.status >= 200 && g.status < 300 ? g.body : null; }
    }
    row.fetched = text !== null;
    let file = null;
    try { file = text === null ? null : JSON.parse(text); } catch { /* not JSON */ }
    const services = Array.isArray(file?.services) ? file.services : Array.isArray(file?.endpoints) ? file.endpoints : null;
    row.json = !!file && typeof file === "object";
    row.typeV1 = file?.type === REG_TYPE;
    row.valid = row.json && typeof file.name === "string" && file.name.trim() !== "" && !!services;
    row.servicesKey = Array.isArray(file?.services) ? "services" : Array.isArray(file?.endpoints) ? "endpoints" : null;
    const https = (services ?? []).map((s) => s?.endpoint).filter((e) => typeof e === "string" && /^https?:\/\//i.test(e)).slice(0, 5);
    row.httpEndpoints = https.length;
    row.endpointHost = https.length ? /^https?:\/\/([^/:?#]+)/i.exec(https[0])?.[1]?.toLowerCase() : null;
    row.name = typeof file?.name === "string" ? file.name.slice(0, 60) : null;
    row.live = false;
    row.live2xx = false;
    for (const e of https) {
      const g = await get(e);
      if (liveStatus(g.status)) row.live = true;
      if (g.status >= 200 && g.status < 300) row.live2xx = true;
      if (row.live && row.live2xx) break;
    }
    row.resolvable = row.valid && row.live;
    return row;
  });
  const n = rows.length;
  const c = (f) => rows.filter(f).length;
  const sum = {
    population: registryWide ? String(registryWide) : ids.length, read: n, schemes: tally(rows.map((r) => r.scheme)),
    nonEmptyUri: c((r) => r.scheme !== "empty" && r.scheme !== "call-reverted"), fetched: c((r) => r.fetched), json: c((r) => r.json), typeV1: c((r) => r.typeV1),
    valid: c((r) => r.valid), withHttpEndpoint: c((r) => r.valid && r.httpEndpoints > 0), resolvable: c((r) => r.resolvable), resolvable2xx: c((r) => r.valid && r.live2xx),
  };
  const top = (f) => Object.entries(tally(rows.map(f).filter(Boolean))).sort((a, b) => b[1] - a[1]).slice(0, 5);
  sum.topUriHosts = top((r) => r.uriHost);
  sum.topEndpointHostsOfResolvable = top((r) => (r.resolvable ? r.endpointHost : null));
  sum.distinctNamesOfResolvable = new Set(rows.filter((r) => r.resolvable).map((r) => r.name)).size;
  sum.topNamesOfResolvable = top((r) => (r.resolvable ? r.name : null)).slice(0, 3);
  const pct = (k) => `${sum[k]}/${n} (${((100 * sum[k]) / n).toFixed(1)}%)`;
  console.log(`   tokenURI scheme: ${JSON.stringify(sum.schemes)}`);
  console.log(`   non-empty URI ${pct("nonEmptyUri")}; file fetched ${pct("fetched")}; JSON ${pct("json")}; type = registration-v1 ${pct("typeV1")}`);
  console.log(`   valid file (JSON object, non-empty name, services/endpoints array) ${pct("valid")}; with ≥1 http(s) endpoint ${pct("withHttpEndpoint")}`);
  console.log(`   concentration: top URI hosts ${JSON.stringify(sum.topUriHosts)}; top first-endpoint hosts of the resolvable ${JSON.stringify(sum.topEndpointHostsOfResolvable)}; distinct names among the resolvable ${sum.distinctNamesOfResolvable} (top ${JSON.stringify(sum.topNamesOfResolvable)})`);
  console.log(`   RESOLVABLE (valid file AND ≥1 endpoint answering GET 200–499 except 404/410 within 10 s) ${pct("resolvable")}; strict (a 2xx) ${pct("resolvable2xx")}`);
  return sum;
}

async function x402Read(viem, rpc, join) {
  console.log(`\n== B x402 facilitator attribution: what it needs, read on the rail`);
  const ref = await headOf(X402_REPO);
  const doc = await gh(X402_REPO, ref, "docs/dev-tools/facilitators.md");
  const listed = [...doc.matchAll(/^\| \[([^\]]+)\]\((https?:\/\/[^)]+)\) \|/gm)].map((m) => ({ name: m[1], url: m[2] }));
  console.log(`   ${X402_REPO}@${ref} docs/dev-tools/facilitators.md lists ${listed.length} facilitators`);
  const signers = new Map(); // lowercased address -> facilitator name
  const probes = await pool(listed, 6, async (f) => {
    const g = await get(`${f.url.replace(/\/$/, "")}/supported`, { json: true });
    let base = null;
    try {
      const j = JSON.parse(g.body ?? "");
      const kinds = Array.isArray(j.kinds) ? j.kinds : [];
      const onBase = kinds.some((k) => k.network === "eip155:8453" || k.network === "base");
      const evm = j.signers?.["eip155:*"] ?? j.signers?.["eip155:8453"] ?? [];
      base = { kindsOnBase: onBase, evmSigners: evm.length };
      if (onBase) for (const s of evm) if (/^0x[0-9a-fA-F]{40}$/.test(s)) signers.set(s.toLowerCase(), f.name);
    } catch { /* not a /supported answer */ }
    return { name: f.name, url: `${f.url.replace(/\/$/, "")}/supported`, status: g.status || g.error, supported: base };
  });
  for (const p of probes) console.log(`   ${p.name.padEnd(28)} GET ${p.url} -> ${p.status}${p.supported ? ` · Base kind ${p.supported.kindsOnBase} · EVM signers ${p.supported.evmSigners}` : " · no /supported JSON"}`);
  console.log(`   published Base signer addresses collected: ${signers.size} from ${new Set(signers.values()).size} facilitators`);

  // The x402 settlement logs on Base: USDC AuthorizationUsed (EIP-3009, "exact"), and the Permit2 proxies' Settled.
  const evmPkg = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/sdk/package.json"));
  const evmDir = path.join(path.dirname(evmPkg.resolve("@x402/evm")), "../esm"); // the resolved entry is dist/cjs
  const src = readdirSync(evmDir).filter((f) => f.endsWith(".mjs")).map((f) => require_(path.join(evmDir, f))).join("\n");
  const exactProxy = /x402ExactPermit2ProxyAddress = "(0x[0-9a-fA-F]{40})"/.exec(src)?.[1];
  const uptoProxy = /x402UptoPermit2ProxyAddress = "(0x[0-9a-fA-F]{40})"/.exec(src)?.[1];
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // packages/reader/src/chains.ts, chain 8453 `usdc`
  const latest = BigInt(await rpc("eth_blockNumber", []));
  const from = latest - BigInt(X402_WINDOW) + 1n;
  const proxyCode = {};
  for (const [k, a] of [["x402ExactPermit2Proxy", exactProxy], ["x402UptoPermit2Proxy", uptoProxy]]) proxyCode[k] = { address: a, bytes: a ? ((await rpc("eth_getCode", [a, "latest"])).length - 2) / 2 : null };
  const authTopic = viem.toEventSelector("AuthorizationUsed(address,bytes32)");
  const auth = await rpc("eth_getLogs", [{ address: usdc, topics: [authTopic], fromBlock: viem.toHex(from), toBlock: viem.toHex(latest) }]);
  const settledTopic = viem.toEventSelector("Settled()");
  const proxyLogs = [];
  for (const a of [exactProxy, uptoProxy].filter(Boolean)) {
    const l = await rpc("eth_getLogs", [{ address: a, fromBlock: viem.toHex(from), toBlock: viem.toHex(latest) }]);
    if (Array.isArray(l)) proxyLogs.push(...l);
  }
  const txs = [...new Set((Array.isArray(auth) ? auth : []).map((l) => l.transactionHash))];
  const txSample = sampleOf(txs, SAMPLE, viem);
  const senders = await pool(txSample, 8, async (h) => (await rpc("eth_getTransactionByHash", [h]))?.from?.toLowerCase());
  const matched = senders.filter((s) => signers.has(s));
  const byFac = tally(matched.map((s) => signers.get(s)));
  console.log(`   x402 proxies on Base (addresses from @x402/evm 2.28.0): ${JSON.stringify(proxyCode)}`);
  console.log(`   window blocks ${from}..${latest} (${X402_WINDOW}): USDC AuthorizationUsed ${Array.isArray(auth) ? auth.length : "error"} logs in ${txs.length} txs; proxy logs ${proxyLogs.length} (Settled() topic ${settledTopic})`);
  console.log(`   tx sender read for ${txSample.length} of those txs: ${new Set(senders).size} distinct senders; sent by a published facilitator signer ${matched.length}/${txSample.length} ${JSON.stringify(byFac)}`);

  // Our own 8453 payment facts: their txs' senders against the same signer set.
  const own = join?.paymentTxSample ?? [];
  const ownSenders = await pool(own, 8, async (h) => (await rpc("eth_getTransactionByHash", [h]))?.from?.toLowerCase());
  const ownMatched = ownSenders.filter((s) => signers.has(s));
  console.log(`   our 8453 payment facts (sample: ${own.length} rows, the first page of the (chain_id, payer) index after payer 0x8): sent by a published facilitator signer ${ownMatched.length}/${own.length} ${JSON.stringify(tally(ownMatched.map((s) => signers.get(s))))}`);
  return {
    x402Ref: ref, listed: listed.length, probes, signerCount: signers.size, facilitatorsWithBaseSigners: new Set(signers.values()).size, proxyCode,
    window: { from: String(from), to: String(latest), authorizationUsed: Array.isArray(auth) ? auth.length : null, txs: txs.length, proxyLogs: proxyLogs.length, sampled: txSample.length, distinctSenders: new Set(senders).size, facilitatorSent: matched.length, byFacilitator: byFac },
    own: { sampled: own.length, facilitatorSent: ownMatched.length },
  };
}

function require_(f) {
  return readFileSync(f, "utf8");
}

// ───────────────────────────── inside ─────────────────────────────

// The no-join form (S234 A3/A4 completion; the cut-twice lessons). The DB never computes an intersection: every
// statement is a per-table keyset page or a bounded ANY($1) probe on an existing (chain_id, <address>) index, or a
// count over one; no join, no DISTINCT, no function on any column; statement_timeout 120 s. Normalization is
// script-side only (Ponder stores hex lowercase; the script checks every value). Memory: only OUR subject sets stay
// resident (~0.46M addresses); the registry tables stream past them page by page and are tested for membership,
// never held. Keyset pages on a non-unique column skip the rest of a value's rows at a page boundary, so a walk
// counts distinct values exactly and rows not at all: row counts come from separate count(*) statements.
// Cut 1 was a whole-table DISTINCT CTE with lower() on indexed columns; cut 2 was the console's Node heap holding all
// four address sets at once (the run output's V8 stack).
const PAGE = 50000;
const CHUNK = 5000;

async function inside() {
  const pnpm = "/app/node_modules/.pnpm";
  const pgDir = readdirSync(pnpm).find((d) => /^pg@\d/.test(d));
  if (!pgDir) throw new Error("pg not found under /app/node_modules/.pnpm");
  const { Client } = (await import(path.join(pnpm, pgDir, "node_modules/pg/lib/index.js"))).default;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  let statements = 0;
  const q = async (sql, params = []) => { statements++; return (await c.query(sql, params)).rows; };
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(0)} s, ${statements} statements, heap ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} MiB`;
  try {
    await c.query("begin isolation level repeatable read read only");
    await c.query("set local statement_timeout = '120s'");
    const def = (await q(`select definition from pg_views where schemaname = 'reader' limit 1`))[0]?.definition ?? "";
    const schema = /FROM\s+"?([A-Za-z0-9_-]+)"?\./i.exec(def)?.[1];
    if (!schema) throw new Error("live schema not found in the reader views");
    const s = (t) => `"${schema}".${t}`;
    const [{ now }] = await q(`select now()::text as now`);
    console.log(`   at ${now} live schema ${schema} (one read-only repeatable-read transaction; no-join form)`);
    const lowerOnly = (a) => { if (a !== a.toLowerCase()) throw new Error(`stored address not lowercase: ${a}`); return a; };

    // Walk one indexed address column on CHAIN in keyset pages; call `each` once per distinct value; return the count.
    async function walk(table, col, each) {
      let last = "", distinct = 0, prev = null;
      for (;;) {
        const page = await q(`select ${col} as a from ${s(table)} where chain_id = $1 and ${col} > $2 order by chain_id, ${col} limit ${PAGE}`, [CHAIN, last]);
        if (!page.length) break;
        for (const r of page) { const a = lowerOnly(r.a); if (a !== prev) { distinct++; each(a); prev = a; } }
        last = page.at(-1).a;
      }
      const [{ n }] = await q(`select count(*)::bigint as n from ${s(table)} where chain_id = $1 and ${col} is not null`, [CHAIN]);
      console.log(`   ${table}.${col}: ${n} non-null rows, ${distinct} distinct (${at()})`);
      return { rows: Number(n), distinct };
    }
    // (a) our subject sets, resident.
    const G = new Set(), P = new Set();
    const g = await walk("external_permissions", "subject", (a) => G.add(a));
    const p = await walk("external_payments", "payer", (a) => P.add(a));
    // (b) the registry columns, streamed past (a); only the hits are kept.
    const GW = new Set(), PW = new Set(), GO = new Set(), PO = new Set();
    const w = await walk("agent_wallets", "wallet", (a) => { if (G.has(a)) GW.add(a); if (P.has(a)) PW.add(a); });
    const o = await walk("agent_owners", "owner", (a) => { if (G.has(a)) GO.add(a); if (P.has(a)) PO.add(a); });
    const subj = new Set([...G, ...P]).size;
    G.clear(); P.clear();
    const ov = [...new Set([...GW, ...PW, ...GO, ...PO])].sort();
    const n = {
      grantSubjects: g, payers: p, allSubjects: subj, agentWallets: w, agentOwners: o,
      grant_x_wallet: GW.size, grant_x_owner: GO.size, payer_x_wallet: PW.size, payer_x_owner: PO.size,
      grant_x_bound: new Set([...GW, ...GO]).size, payer_x_bound: new Set([...PW, ...PO]).size, subjects_x_bound: ov.length,
    };
    console.log(`   INTERSECTIONS (distinct addresses on ${CHAIN}): grant subjects ∩ ever-agentWallet ${n.grant_x_wallet}; grant subjects ∩ ever-owner ${n.grant_x_owner}; payers ∩ ever-agentWallet ${n.payer_x_wallet}; payers ∩ ever-owner ${n.payer_x_owner}`);
    console.log(`   derived: grant subjects ∩ (wallet ∪ owner) ${n.grant_x_bound}; payers ∩ (wallet ∪ owner) ${n.payer_x_bound}; all subjects ∩ (wallet ∪ owner) ${n.subjects_x_bound} of ${subj} subjects`);

    // The intersection's agentIds: bounded ANY($1) probes on the two address indexes.
    const ids = new Set();
    for (let i = 0; i < ov.length; i += CHUNK) {
      const ch = ov.slice(i, i + CHUNK);
      for (const r of await q(`select agent_id::text id from ${s("agent_wallets")} where chain_id = $1 and wallet = any($2)`, [CHAIN, ch])) ids.add(r.id);
      for (const r of await q(`select agent_id::text id from ${s("agent_owners")} where chain_id = $1 and owner = any($2)`, [CHAIN, ch])) ids.add(r.id);
    }
    const idList = [...ids].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    console.log(`   agentIds bound (ever, agentWallet or owner) to an intersection address: ${idList.length} (agentId 0 among them: ${ids.has("0")}) (${at()})`);
    await c.query("rollback");
    console.log(`   read in ${at()}`);
    console.log(`JOIN-JSON ${JSON.stringify({
      at: now, schema, statements, seconds: Math.round((Date.now() - t0) / 1000), populations: n,
      // Over 50,000: every k-th of the sorted list (evenly spaced, stated), not the first 50,000.
      overlapAgentIdCount: idList.length,
      overlapAgentIds: idList.length <= 50000 ? idList : idList.filter((_, i) => i % Math.ceil(idList.length / 50000) === 0),
    })}`);
  } finally {
    await c.end();
  }
}

// Dispatch last: the helpers above are `const`s, not hoisted.
if (process.argv[2] === "--inside") await inside();
else await outside();
