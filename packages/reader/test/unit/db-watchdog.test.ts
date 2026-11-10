// Exit, not idle, on database loss (src/api/db-watchdog.ts, S211): the process exits 75 once the newest Ponder
// heartbeat seen is older than the limit, whether the read fails, hangs or returns an old value.

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { dbWatchdog, heartbeatSql } from "../../src/api/db-watchdog.ts";

function rig(read: () => Promise<number>) {
  let t = 1_000_000;
  const exits: number[] = [];
  const logs: string[] = [];
  const check = dbWatchdog(read, { staleMs: 120_000, probeMs: 50, now: () => t, exit: (c) => exits.push(c), log: (m) => logs.push(m) });
  return { check, exits, logs, advance: (ms: number) => (t += ms), now: () => t };
}

describe("db watchdog", () => {
  it("fresh heartbeats keep the process up", async () => {
    let r!: ReturnType<typeof rig>;
    r = rig(async () => r.now() - 5_000);
    for (let i = 0; i < 20; i++) {
      r.advance(15_000);
      await r.check();
    }
    expect(r.exits).toEqual([]);
  });

  it("a failing read (database gone) exits 75 once past the limit, not before", async () => {
    const r = rig(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    r.advance(120_000);
    await r.check();
    expect(r.exits).toEqual([]);
    r.advance(1);
    await r.check();
    expect(r.exits).toEqual([75]);
    expect(r.logs[0]).toMatch(/^db watchdog FATAL: no Ponder heartbeat for 120 s/);
  });

  it("a hanging read counts as failed", async () => {
    const r = rig(() => new Promise<number>(() => {}));
    r.advance(130_000);
    await r.check();
    expect(r.exits).toEqual([75]);
  });

  it("a readable but stale heartbeat (writer stalled) exits 75", async () => {
    let r!: ReturnType<typeof rig>;
    let last = 0;
    r = rig(async () => last);
    last = r.now() + 10_000;
    r.advance(10_000);
    await r.check();
    r.advance(121_000);
    await r.check();
    expect(r.exits).toEqual([75]);
  });

  it("recovers: a fresh heartbeat after a short outage resets the clock", async () => {
    let r!: ReturnType<typeof rig>;
    let down = true;
    r = rig(async () => {
      if (down) throw new Error("57P01");
      return r.now();
    });
    r.advance(100_000);
    await r.check();
    down = false;
    await r.check();
    r.advance(100_000);
    down = true;
    await r.check();
    expect(r.exits).toEqual([]);
  });

  it("the heartbeat SQL reads Ponder's _ponder_meta 'app' row in the named schema", async () => {
    const pg = new PGlite();
    await pg.exec(`create schema "deployment-01m6"; create table "deployment-01m6"._ponder_meta (key text primary key, value jsonb not null);
      insert into "deployment-01m6"._ponder_meta values ('app', '{"heartbeat_at": 1762736795123, "is_ready": 1}'), ('status', '{}');`);
    const r = await pg.query<{ h: string | number }>(heartbeatSql("deployment-01m6"));
    expect(Number(r.rows[0]!.h)).toBe(1762736795123);
    expect(heartbeatSql('a"b')).toContain('"a""b"._ponder_meta');
    await pg.close();
  });
});
