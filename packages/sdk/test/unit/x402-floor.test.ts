// V12 x402 disclosure (Oct 22): every @x402/* the SDK depends on is at or above 2.23.0, the fix line. Read from
// package.json, not node_modules, so a downgrade fails here before anything is installed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FLOOR = [2, 23, 0] as const;

/** An exact pin "MAJOR.MINOR.PATCH"; ranges and tags are refused (the SDK pins exactly). */
function parsePin(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not an exact version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const atLeast = (v: readonly number[], floor: readonly number[]) => {
  for (let i = 0; i < 3; i++) if (v[i] !== floor[i]) return v[i]! > floor[i]!;
  return true;
};

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
const x402 = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }).filter(([n]) => n.startsWith("@x402/")) as [string, string][];

describe("x402 floor (V12)", () => {
  it("finds the @x402 packages", () => expect(x402.length).toBeGreaterThan(0));
  for (const [name, version] of x402) {
    it(`${name}@${version} is ≥ ${FLOOR.join(".")}`, () => expect(atLeast(parsePin(version), FLOOR)).toBe(true));
  }
  it("the comparison refuses what it should", () => {
    expect(atLeast(parsePin("2.22.9"), FLOOR)).toBe(false);
    expect(atLeast(parsePin("2.23.0"), FLOOR)).toBe(true);
    expect(atLeast(parsePin("3.0.0"), FLOOR)).toBe(true);
    expect(() => parsePin("^2.28.0")).toThrow(/not an exact version/);
  });
});
