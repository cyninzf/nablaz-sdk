// scripts/reader-start.sh's schema choice (R-S202-4, S202): READER_SCHEMA, when set and non-empty, names the schema
// Ponder starts on (a resume of an existing schema); unset or empty, the schema is the deployment's image tag from
// FLY_IMAGE_REF, lower-cased, digest removed, at most 45 characters. The script's own lines run under bash here,
// since the whole script starts Ponder and the front.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new URL("../../../../scripts/reader-start.sh", import.meta.url), "utf8").split("\n");
const SCHEMA_LINE = `SCHEMA=\${READER_SCHEMA:-$(printf '%s' "\${ref##*:}" | tr 'A-Z' 'a-z' | cut -c1-45)}`;
const REF = "registry.fly.io/nablaz-reader:deployment-01M6P05TWT15F0PB31GR64T2P3@sha256:0123abcd";

/** Runs the script's ref= and SCHEMA= lines under bash with `env`, and returns $SCHEMA. */
function schema(env: Record<string, string>): string {
  const lines = SCRIPT.filter((l) => /^(ref|SCHEMA)=/.test(l));
  expect(lines).toHaveLength(2);
  return execFileSync("bash", ["-euo", "pipefail", "-c", `${lines.join("\n")}\nprintf '%s' "$SCHEMA"`], { env: { PATH: process.env.PATH!, ...env }, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

describe("reader-start.sh schema", () => {
  it("line 17 is the ruled READER_SCHEMA line, and its $SCHEMA is what Ponder starts with", () => {
    expect(SCRIPT[16]).toBe(SCHEMA_LINE);
    expect(SCRIPT.some((l) => l.includes(`ponder start --schema "$SCHEMA"`))).toBe(true);
  });

  it("unset READER_SCHEMA: the image tag, lower-cased, digest removed", () => {
    expect(schema({ FLY_IMAGE_REF: REF })).toBe("deployment-01m6p05twt15f0pb31gr64t2p3");
  });

  it("empty READER_SCHEMA falls back to the image tag too", () => {
    expect(schema({ FLY_IMAGE_REF: REF, READER_SCHEMA: "" })).toBe("deployment-01m6p05twt15f0pb31gr64t2p3");
  });

  it("READER_SCHEMA set: that schema, as given, whatever the image tag", () => {
    const next = "registry.fly.io/nablaz-reader:deployment-01M6ZZZZZZZZZZZZZZZZZZZZZZ";
    expect(schema({ FLY_IMAGE_REF: next, READER_SCHEMA: "deployment-01m6p05twt15f0pb31gr64t2p3" })).toBe("deployment-01m6p05twt15f0pb31gr64t2p3");
  });

  it("the tag is cut at Ponder's 45 characters", () => {
    expect(schema({ FLY_IMAGE_REF: `r/a:${"X".repeat(60)}` })).toBe("x".repeat(45));
  });
});
