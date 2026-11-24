// The registration surfaces (S201): the ERC-8004 registration file served by the front at
// GET /.well-known/agent-registration.json (EIP-8004's own path, R-S201-6), byte for byte from packages/mcp/static/, and server.json for the
// MCP Registry. Every other /.well-known path stays 404. The registry address is compared with the committed
// generated file (S186-L1/L2: copied, never typed). The prose fields follow the copy discipline (DoR §10).

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTRATION_PATH, readHttpServer } from "../../src/http.ts";
import erc8004 from "../../../reader/src/generated/erc8004.json";

const FILE = readFileSync(new URL("../../static/agent-registration.json", import.meta.url));
const SERVER_JSON = JSON.parse(readFileSync(new URL("../../../../server.json", import.meta.url), "utf8")) as Record<string, unknown>;
/** The registration-v1 type string, as EIP-8004 states it (fetched from eips.ethereum.org, S201). */
const EIP_8004_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

const server = readHttpServer({ readerUrl: "http://127.0.0.1:1" });
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("GET /.well-known/agent-registration.json", () => {
  it("(a) 200, application/json, and the body is the committed file, byte for byte", async () => {
    expect(REGISTRATION_PATH).toBe("/.well-known/agent-registration.json");
    const r = await fetch(`${base}/.well-known/agent-registration.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(Buffer.from(await r.arrayBuffer()).equals(FILE)).toBe(true);
  });

  it("(b) type is the EIP string; registrations[0] binds agentId 1650 to the generated 42161 IdentityRegistry", async () => {
    const body = (await (await fetch(`${base}/.well-known/agent-registration.json`)).json()) as {
      type: string;
      registrations: { agentId: number; agentRegistry: string }[];
    };
    expect(body.type).toBe(EIP_8004_TYPE);
    expect(body.registrations).toHaveLength(1);
    expect(body.registrations[0]!.agentId).toBe(1650);
    expect(body.registrations[0]!.agentRegistry).toBe(`eip155:42161:${erc8004.chains["42161"].IdentityRegistry}`);
  });

  it("(c) every other /.well-known path is 404", async () => {
    for (const p of ["/.well-known/", "/.well-known/anything-else", "/.well-known/agent-registration.json/x", "/.well-known/AGENT-REGISTRATION.JSON"]) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(404);
    }
  });

  it("the superseded path is 404, not a redirect (it was never published)", async () => {
    const r = await fetch(`${base}/.well-known/erc8004-registration.json`, { redirect: "manual" });
    expect(r.status).toBe(404);
  });

  it("only GET serves it", async () => {
    expect((await fetch(`${base}/.well-known/agent-registration.json`, { method: "POST" })).status).toBe(404);
  });
});

describe("copy discipline in both files (DoR §10)", () => {
  // Banned as self-description, "first"/"only", "integrated with", and chain names in prose. Machine-readable
  // identifiers (eip155:42161, URLs) are data, not prose: only the prose fields are checked.
  const BANNED = [/\bscore\b/i, /trust score/i, /reputation/i, /receipts?/i, /credit bureau/i, /proven income/i, /\bdeposit/i, /\bfirst\b/i, /\bonly\b/i, /integrated with/i, /\barbitrum\b/i, /\bbase\b/i, /\bethereum\b/i, /\boptimism\b/i, /\blive\b/i, /\d{2,}/];
  const reg = JSON.parse(FILE.toString("utf8")) as Record<string, unknown>;
  const prose = [reg.name, reg.description, SERVER_JSON.description, SERVER_JSON.title].filter((x): x is string => typeof x === "string");

  it("no banned word, no count, in any prose field", () => {
    expect(prose.length).toBeGreaterThanOrEqual(3);
    for (const s of prose) for (const b of BANNED) expect(s, `${b} in "${s}"`).not.toMatch(b);
  });

  it("the registration file has no image field (no hosted image exists)", () => {
    expect(reg).not.toHaveProperty("image");
  });

  it("server.json: name, remote and repository as dispatched", () => {
    expect(SERVER_JSON.name).toBe("io.nablaz/reader");
    expect(SERVER_JSON.remotes).toEqual([{ type: "streamable-http", url: "https://read.nablaz.io/mcp" }]);
    expect(SERVER_JSON.repository).toEqual({ url: "https://github.com/cyninzf/nablaz-sdk", source: "github" });
  });
});

// S227 strings event (retro-sweep: the record is the whole AI agent economy, on and off chain; today's citation
// home is an instrument fact, never a definition). Supersession, kept here only so the change is legible:
//   MCP description, was:          "Read NablaZ's open record: agent actions under permission, cited onchain. Evidence, not a verdict."
//   registration description, was: "...the actions an account took under permission with onchain citations, readable by anyone..."
// Ruled strings: byte-exact, no case or punctuation latitude.
describe("ruled description bytes (S227)", () => {
  const MCP_DESCRIPTION = "Read NablaZ's open record: agent actions under permission, cited. Evidence, not a verdict.";
  const REGISTRATION_DESCRIPTION =
    "NablaZ is the open record for the AI agent economy. Your agent acts under the permission you gave it; the record it leaves is credit you own. This identity's record is served by the NablaZ open reader: the actions an account took under permission with citations, readable by anyone over HTTP and MCP. Evidence, not a verdict.";

  const read = (rel: string) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json")) as { plugins: { name: string; description?: string }[] };
  /** README: the one line under "### Using the hosted reader from Claude", after its blank line. */
  const readmeLine = (() => {
    const lines = read("README.md").split("\n");
    const h = lines.indexOf("### Using the hosted reader from Claude");
    expect(h, "README heading").toBeGreaterThanOrEqual(0);
    expect(lines[h + 1]).toBe("");
    return lines[h + 2];
  })();
  const homes: [string, unknown][] = [
    ["server.json", SERVER_JSON.description],
    [".claude-plugin/marketplace.json", marketplace.plugins.find((p) => p.name === "nablaz")?.description],
    ["README.md", readmeLine],
  ];

  it("the MCP description is byte-identical across its three homes and is the ruled string", () => {
    for (const [home, s] of homes) expect(s, home).toBe(MCP_DESCRIPTION);
    expect(new Set(homes.map(([, s]) => s)).size).toBe(1);
  });

  it("the registration description is the ruled string", () => {
    const reg = JSON.parse(FILE.toString("utf8")) as { description: string };
    expect(reg.description).toBe(REGISTRATION_DESCRIPTION);
  });

  it("no home carries the onchain scope word", () => {
    for (const [home, s] of [...homes, ["agent-registration.json", (JSON.parse(FILE.toString("utf8")) as { description: string }).description] as const])
      expect(s, home).not.toMatch(/onchain/i);
  });
});
