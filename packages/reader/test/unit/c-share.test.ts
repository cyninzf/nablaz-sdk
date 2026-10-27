// R-S190-3: the whole-index (c) share (src/c-share.ts, used by `pnpm report:c-share`) on an in-memory PGlite
// with the reader's column names: external payments take their permission's shape, (c) when the permission row
// is missing; vault payments take their account's shape; values are never summed across tokens.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { cShareOverIndex, formatShare } from "../../src/c-share";

const T1 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const T2 = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const ACC = "0x00000000000000000000000000000000000000a1";
const db = new PGlite();
const q = async <T>(sql: string, params: unknown[]) => (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  await db.exec(`CREATE SCHEMA reader;
    CREATE TABLE reader.external_payments (chain_id int, block_number numeric, source text, token text, amount numeric, permission_id text);
    CREATE TABLE reader.external_permissions (id text, shape text);
    CREATE TABLE reader.vault_payments (chain_id int, block_number numeric, account text, token text, value numeric, payee text);
    INSERT INTO reader.external_permissions VALUES ('8453-spm-0xaa', 'a'), ('8453-dm-0xbb', 'c'), ('8453-dm-0xcc', 'b');
    INSERT INTO reader.external_payments VALUES
      (8453, 10, 'spm', '${T1}', 100, '0xAA'),
      (8453, 11, 'delegation_manager', '${T1}', 30, '0xbb'),
      (8453, 12, 'delegation_manager', '${T1}', 7, '0xdd'),
      (8453, 13, 'delegation_manager', '${T2}', 5, '0xcc'),
      (8453, 99, 'spm', '${T1}', 1000, '0xaa'),
      (42161, 10, 'spm', '${T1}', 1000, '0xaa');
    INSERT INTO reader.vault_payments VALUES (8453, 10, '${ACC}', '${T2}', 50, '0x01'), (8453, 10, '${ACC}', '${T2}', 999, NULL);`);
});
afterAll(() => db.close());

describe("cShareOverIndex", () => {
  it("per token over the chain and block range, joined as GET /read labels them", async () => {
    const shapes: string[] = [];
    const r = await cShareOverIndex(q, 8453, 10n, 20n, async (a) => (shapes.push(a), "c"));
    expect(shapes).toEqual([getAddress(ACC)]);
    expect(r).toEqual({
      [getAddress(T1)]: { c: 2, total: 3, cValue: 37n, totalValue: 137n },
      [getAddress(T2)]: { c: 1, total: 2, cValue: 50n, totalValue: 55n },
    });
    expect(formatShare(8453, 10n, 20n, r)[0]).toBe(`chain 8453 blocks 10..20 token ${getAddress(T1)}: (c) 2 of 3 payment facts (66.6666%); (c) value 37 of 137 (27.0072%)`);
  });
  it("says nothing indexed when the range holds no payment fact", async () => {
    expect(formatShare(8453, 30n, 40n, await cShareOverIndex(q, 8453, 30n, 40n, async () => "a"))).toEqual(["chain 8453 blocks 30..40: nothing indexed (no payment fact in the range)"]);
  });
});
