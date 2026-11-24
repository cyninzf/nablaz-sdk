// Enumeration pick #1, step 2 (S226): distinct grantors over the last N days (default 30) on chains the reader does
// NOT index, from the contracts' own grant events, decoded exactly as the reader decodes them:
//   DelegationManager       RedeemedDelegation       grantor = delegation.delegator (src/delegation.ts decodeRedeemedDelegation,
//                                                    the decoder behind src/external.ts; one event per hop)
//   SpendPermissionManager  SpendPermissionApproved  grantor = spendPermission.account (src/external-abis.ts, as src/external.ts)
// Read-only. Provider access: the existing Alchemy key of the Arbitrum grounding leg (CHAINS[42161].groundingRpcEnv,
// src/chains.ts), on each target network's Alchemy host; no new key (the four-step rule). A network the key's app
// cannot reach is reported as NO ENDPOINT and skipped, never worked around. URLs never reach the output (redactUrls).
//
// Before counting, the bytecode gate (R-S226-7), in order; any failure is reported and that target is not counted:
//   1. The target's runtime code is byte-identical to the indexed chains' (every enabled chain carrying that source
//      in src/chains.ts) outside the MASK: the positions where the indexed chains already differ from each other.
//   2. The masked bytes verify as the chain-dependent values they claim to be:
//      - each 2-byte masked run is the low end of a 32-byte word that MUST equal the target's chain id (uint256);
//      - each 32-byte masked run SHOULD equal the EIP-712 domain separator recomputed for that contract, on that
//        chain, at that address: keccak256(abi.encode(EIP712Domain typehash, keccak(name), keccak(version), chainId,
//        address)), with name and version read from the contract's own eip712Domain() (EIP-5267). If that read is
//        unavailable the word is reported as INFERRED, and the chain-id check plus the mask carry the gate.
//      The same two checks run on every indexed chain first, so the method proves itself on known deployments.
// For the record (R-S226-7): each target sits at the SAME canonical CREATE2 address as the indexed chains. A CREATE2
// address binds the initcode, so the runtime code can differ only by values computed at construction from the
// chain (chain id, the cached domain separator); those positions are exactly what the mask covers.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/grantor-count.ts [--days 30] [target ...]
//   target = <contract>@<network>, contract dm | spm, network optimism | linea | gnosis (default: the four CTO hits)
//
// Falsifier (the dive's, pre-stated): a chain under 500 distinct grantors in 30 days does not join.

import {
  bytesToHex,
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  hexToBytes,
  http,
  keccak256,
  numberToBytes,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { CHAINS } from "../src/chains.ts";
import { DelegationManagerAbi, decodeRedeemedDelegation } from "../src/delegation.ts";
import { SpendPermissionManagerAbi } from "../src/external-abis.ts";
import { redactUrls } from "../src/rpc.ts";

const DM: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const SPM: Address = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
const NETWORKS: Record<string, { host: string; chainId: number }> = {
  optimism: { host: "opt-mainnet", chainId: 10 },
  linea: { host: "linea-mainnet", chainId: 59144 },
  gnosis: { host: "gnosis-mainnet", chainId: 100 },
};
const CONTRACTS = {
  dm: { name: "DelegationManager" as const, address: DM, event: "RedeemedDelegation", abi: DelegationManagerAbi },
  spm: { name: "SpendPermissionManager" as const, address: SPM, event: "SpendPermissionApproved", abi: SpendPermissionManagerAbi },
};
const DEFAULT_TARGETS = ["dm@optimism", "dm@linea", "dm@gnosis", "spm@optimism"];
const FALSIFIER = 500;

const args = process.argv.slice(2);
const daysAt = args.indexOf("--days");
const days = daysAt >= 0 ? Number(args.splice(daysAt, 2)[1]) : 30;
if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a positive integer");
const targets = args.length ? args : DEFAULT_TARGETS;

const baseEnv = CHAINS[42161]!.groundingRpcEnv;
const baseUrl = process.env[baseEnv];
if (!baseUrl) throw new Error(`${baseEnv} is not set (the existing Alchemy key; src/chains.ts)`);
const m = /^(https:\/\/)[a-z0-9-]+(\.g\.alchemy\.com\/v2\/.+)$/.exec(baseUrl);
if (!m) throw new Error(`${baseEnv} is not an Alchemy URL of the form https://<network>.g.alchemy.com/v2/<key>`);
const urlOf = (host: string) => `${m[1]}${host}${m[2]}`;
/** The provider's own reason (viem's `details` carries it; its message is generic for -32600), URLs redacted. */
const clean = (e: unknown, url: string) => {
  const x = e as { details?: string; message?: string };
  return redactUrls(String(x?.details || x?.message || e).split("\n")[0]!, url, "grounding").replace(/Visit this page.*$/, "").trim();
};
const client = (url: string) => createPublicClient({ transport: http(url, { retryCount: 2, timeout: 60_000 }) }) as PublicClient;

/** Each enabled indexed chain carrying the source, by its own grounding leg. */
function referenceClients(source: "DelegationManager" | "SpendPermissionManager"): { chainId: number; c: PublicClient; url: string }[] {
  return Object.values(CHAINS)
    .filter((ch) => ch.enabled && ch.external[source] !== null && process.env[ch.groundingRpcEnv])
    .map((ch) => ({ chainId: ch.chainId, url: process.env[ch.groundingRpcEnv]!, c: client(process.env[ch.groundingRpcEnv]!) }));
}

const codeOf = async (c: PublicClient, a: Address): Promise<Uint8Array | null> => {
  const code = await c.getCode({ address: a });
  return code && code !== "0x" ? hexToBytes(code) : null;
};

/** Maximal runs [start, end] of consecutive positions. */
const runsOf = (ps: number[]) => ps.reduce<[number, number][]>((out, p) => (out.length && out.at(-1)![1] === p - 1 ? (out.at(-1)![1] = p, out) : [...out, [p, p]]), []);
const fmtRuns = (rs: [number, number][]) => rs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
const word = (code: Uint8Array, end: number) => bytesToHex(code.slice(end - 31, end + 1));

const EIP712_DOMAIN_TYPEHASH = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const EIP5267 = parseAbi(["function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)"]);

/** The domain separator recomputed from the contract's own name and version, for `chainId` and `address`; null if unreadable. */
async function domainSeparator(c: PublicClient, address: Address, chainId: number): Promise<{ sep: Hex; name: string; version: string } | null> {
  try {
    const [fields, name, version] = await c.readContract({ address, abi: EIP5267, functionName: "eip712Domain" });
    if (fields !== "0x0f") return null; // only the name/version/chainId/verifyingContract domain is recomputed here
    const sep = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [EIP712_DOMAIN_TYPEHASH, keccak256(toHex(name)), keccak256(toHex(version)), BigInt(chainId), address]));
    return { sep, name, version };
  } catch {
    return null;
  }
}

/** Gate step 2 for one deployment: every masked run verified. Returns the failures and the inferred notes. */
async function verifyMask(c: PublicClient, address: Address, chainId: number, code: Uint8Array, runs: [number, number][]): Promise<{ fail: string[]; notes: string[] }> {
  const fail: string[] = [];
  const notes: string[] = [];
  const chainWord = bytesToHex(numberToBytes(BigInt(chainId), { size: 32 }));
  let dom: Awaited<ReturnType<typeof domainSeparator>> | undefined;
  for (const [a, b] of runs) {
    const len = b - a + 1;
    if (len <= 2) {
      const w = word(code, b);
      if (w !== chainWord) fail.push(`bytes ${a}-${b}: word ${w} is not chain id ${chainId}`);
      else notes.push(`bytes ${a}-${b}: chain id ${chainId} (0x${chainId.toString(16).padStart(4, "0")}) VERIFIED`);
    } else if (len <= 32) {
      const w = word(code, a + 31);
      dom ??= await domainSeparator(c, address, chainId);
      if (!dom) notes.push(`bytes ${a}-${b}: 32-byte word INFERRED as the domain separator (eip712Domain() unreadable)`);
      else if (w !== dom.sep) fail.push(`bytes ${a}-${b}: word ${w} is not the recomputed domain separator ${dom.sep} ("${dom.name}" v${dom.version})`);
      else notes.push(`bytes ${a}-${b}: EIP-712 domain separator ("${dom.name}" v${dom.version}, chain ${chainId}, ${address}) VERIFIED`);
    } else fail.push(`bytes ${a}-${b}: a masked run of ${len} bytes is not a chain id or a domain separator`);
  }
  return { fail, notes };
}

/** The first block whose timestamp is at or after `ts` (binary search on block timestamps). */
async function blockAt(c: PublicClient, ts: bigint, latest: bigint): Promise<bigint> {
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await c.getBlock({ blockNumber: mid });
    if (b.timestamp < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** Every log of `topic0` at `address` in [from, to], bisecting any range the provider refuses as too large. */
async function logs(c: PublicClient, address: Address, topic0: Hex, from: bigint, to: bigint, url: string, calls = { n: 0 }): Promise<Log[]> {
  calls.n++;
  try {
    return await c.request({ method: "eth_getLogs", params: [{ address, topics: [topic0], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }) as unknown as Log[];
  } catch (e) {
    if (from >= to) throw new Error(`eth_getLogs failed on a single block ${from}: ${clean(e, url)}`);
    const mid = (from + to) / 2n;
    return [...(await logs(c, address, topic0, from, mid, url, calls)), ...(await logs(c, address, topic0, mid + 1n, to, url, calls))];
  }
}

for (const t of targets) {
  const [k, net] = t.split("@") as [keyof typeof CONTRACTS, string];
  const ct = CONTRACTS[k];
  const nw = NETWORKS[net];
  if (!ct || !nw) throw new Error(`unknown target ${t}`);
  const url = urlOf(nw.host);
  const c = client(url);
  console.log(`\n== ${ct.name} ${ct.address} on ${net} (chain ${nw.chainId})`);

  // 1. Endpoint: the existing key on this network.
  let chainId: number;
  try {
    chainId = await c.getChainId();
  } catch (e) {
    console.log(`   NO ENDPOINT: the existing Alchemy key does not answer on ${nw.host} (${clean(e, url)}); not counted`);
    continue;
  }
  if (chainId !== nw.chainId) {
    console.log(`   NO ENDPOINT: ${nw.host} answered chain ${chainId}, expected ${nw.chainId}; not counted`);
    continue;
  }

  // 2. The bytecode gate (R-S226-7; header).
  const here = await codeOf(c, ct.address);
  const refs = await Promise.all(referenceClients(ct.name).map(async (r) => ({ ...r, code: await codeOf(r.c, ct.address) })));
  if (!here || refs.length < 2 || refs.some((r) => !r.code || r.code.length !== here.length)) {
    console.log(`   GATE FAIL: no code, fewer than two indexed references, or a length mismatch (target ${here?.length ?? 0} bytes; indexed ${refs.map((r) => `${r.chainId} ${r.code?.length ?? 0}`).join(", ")}); not counted`);
    continue;
  }
  const mask = new Set<number>();
  for (let i = 0; i < here.length; i++) if (refs.some((r) => r.code![i] !== refs[0]!.code![i])) mask.add(i);
  const runs = runsOf([...mask]);
  const outside: number[] = [];
  for (let i = 0; i < here.length; i++) if (!mask.has(i) && here[i] !== refs[0]!.code![i]) outside.push(i);
  const differ = [...Array(here.length).keys()].filter((i) => here[i] !== refs[0]!.code![i]);
  console.log(`   code: ${here.length} bytes; mask (indexed ${refs.map((r) => r.chainId).join(" vs ")} differ): ${mask.size} bytes at ${fmtRuns(runs)}`);
  console.log(`   gate 1: target differs from ${refs[0]!.chainId} at ${differ.length} bytes (${fmtRuns(runsOf(differ))}); outside the mask: ${outside.length}${outside.length ? ` (${fmtRuns(runsOf(outside))})` : ""}`);
  if (outside.length) {
    console.log(`   GATE FAIL (1): bytes differ outside the mask; not counted`);
    continue;
  }
  const checks = [...refs.map((r) => ({ label: `indexed ${r.chainId}`, c: r.c, chainId: r.chainId, code: r.code! })), { label: `target ${nw.chainId}`, c, chainId: nw.chainId, code: here }];
  let gate2 = true;
  for (const k of checks) {
    const v = await verifyMask(k.c, ct.address, k.chainId, k.code, runs);
    for (const n of v.notes) console.log(`   gate 2 ${k.label}: ${n}`);
    for (const f of v.fail) console.log(`   gate 2 ${k.label}: FAIL ${f}`);
    if (v.fail.length) gate2 = false;
  }
  if (!gate2) {
    console.log(`   GATE FAIL (2): a masked value does not verify; not counted`);
    continue;
  }
  console.log(`   gate: PASS`);

  // 3. The window, by block timestamps.
  const latest = await c.getBlock({ blockTag: "latest" });
  const fromTs = latest.timestamp - BigInt(days * 86_400);
  const from = await blockAt(c, fromTs, latest.number);
  const fromBlock = await c.getBlock({ blockNumber: from });
  const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString().replace(".000Z", "Z");

  // 4. The grant events, decoded as the reader decodes them.
  const topic0 = toEventSelector(ct.abi.find((x: any) => x.type === "event" && x.name === ct.event) as any);
  const calls = { n: 0 };
  const raw = await logs(c, ct.address, topic0, from, latest.number, url, calls);
  const grantors = new Set<string>();
  const roots = new Set<string>();
  for (const l of raw) {
    if (k === "dm") {
      const r = decodeRedeemedDelegation({ topics: l.topics as Hex[], data: l.data as Hex });
      grantors.add(r.delegation.delegator.toLowerCase());
      roots.add(r.rootDelegator.toLowerCase());
    } else {
      const { args: a } = decodeEventLog({ abi: SpendPermissionManagerAbi, eventName: "SpendPermissionApproved", topics: l.topics as [Hex, ...Hex[]], data: l.data as Hex }) as any;
      grantors.add(String(a.spendPermission.account).toLowerCase());
    }
  }

  // 5. Report.
  const n = grantors.size;
  console.log(`   window: blocks ${from}..${latest.number} (${iso(fromBlock.timestamp)} .. ${iso(latest.timestamp)}, ${days} days), ${calls.n} eth_getLogs calls`);
  console.log(`   events: ${raw.length} ${ct.event}`);
  console.log(`   distinct grantors: ${n}${k === "dm" ? ` (distinct root delegators: ${roots.size})` : ""}`);
  console.log(
    `   population: ${k === "dm" ? "distinct delegation.delegator over every RedeemedDelegation (one event per hop, so every hop's delegator); a delegation appears on chain only when redeemed, so signed-but-never-redeemed delegations are not counted" : "distinct spendPermission.account over every SpendPermissionApproved (direct and by signature); a permission used without a prior on-chain approval in the window is not counted"}`,
  );
  console.log(`   falsifier (< ${FALSIFIER} distinct grantors / ${days}d does not join): ${n >= FALSIFIER ? "CLEARS: a candidate join" : "UNDER: does not join"}`);
}
