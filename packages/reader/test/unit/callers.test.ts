// P-GTM-4 (R-S214-11, R-S217-7): the reader's door counters (src/api/callers.ts), served on /metrics/reader beside the
// RPC legs'. Counted only when both internal headers carry a known value; Prometheus text with door, class and stage.

import { beforeEach, describe, expect, it } from "vitest";
import { CALLER_CLASSES, DOORS, countDoor, doorMetricsText, resetDoorCounters } from "../../src/api/callers";

beforeEach(() => resetDoorCounters());

describe("door counters", () => {
  it("counts per (door, class, stage)", () => {
    countDoor("attempt", "read", "unclassified");
    countDoor("attempt", "read", "unclassified");
    countDoor("served", "read", "unclassified");
    countDoor("attempt", "mcp", "fixture");
    expect(doorMetricsText().split("\n").filter((l) => l && !l.startsWith("#"))).toEqual([
      `nablaz_door_requests_total{door="mcp",class="fixture",stage="attempt"} 1`,
      `nablaz_door_requests_total{door="read",class="unclassified",stage="attempt"} 2`,
      `nablaz_door_requests_total{door="read",class="unclassified",stage="served"} 1`,
    ]);
  });

  it("ignores a request without the headers or with a value outside the fixed sets", () => {
    for (const [d, c] of [
      [undefined, undefined],
      ["read", undefined],
      [undefined, "cto"],
      ["feed", "cto"],
      ["read", "admin"],
      ["read", "CTO"],
      ['read",x="1', "cto"],
    ] as const)
      countDoor("attempt", d, c);
    expect(doorMetricsText().split("\n").filter((l) => l && !l.startsWith("#"))).toEqual([]);
  });

  it("every door and class is countable; the text is a valid Prometheus counter block even when empty", () => {
    for (const d of DOORS) for (const c of CALLER_CLASSES) countDoor("served", d, c);
    const t = doorMetricsText();
    expect(t.split("\n").filter((l) => l.startsWith("nablaz_door_requests_total{"))).toHaveLength(DOORS.length * CALLER_CLASSES.length);
    resetDoorCounters();
    expect(doorMetricsText()).toMatch(/^# HELP nablaz_door_requests_total .+\n# TYPE nablaz_door_requests_total counter\n$/);
  });
});
