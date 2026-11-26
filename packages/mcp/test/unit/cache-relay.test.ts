// S233 (R-S232-8 history serving): the front relays the reader's cache-control on a settled-history GET /feed page
// (packages/reader/src/api/feed.ts historyCacheControl) and adds none where the reader set none: the now-edge /feed,
// GET /read and the tx door read exactly as before, headers included.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READER_READY_PATH } from "../../src/server.ts";
import { readHttpServer } from "../../src/http.ts";

const HISTORY = "public, max-age=86400, immutable";
const TEST = "0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c";
const HASH = `0x${"cd".repeat(32)}`;
const FEED = `{"asOfBlock":{"8453":"1"},"items":[],"nextBefore":null}`;

let stub: Server;
let front: Server;
let url: string;

beforeAll(async () => {
  stub = createServer((req, res) => {
    if (req.url === READER_READY_PATH) return res.writeHead(200, { "content-type": "text/plain" }).end("");
    // The reader sets the header only on a bounded, settled page; here: any request carrying ?before or ?at.
    if (req.url!.startsWith("/feed")) return res.writeHead(200, { "content-type": "application/json", ...(/[?&](before|at)=/.test(req.url!) ? { "cache-control": HISTORY } : {}) }).end(FEED);
    return res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  front = readHttpServer({ readerUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}`, feedEnabled: true, txEnabled: true });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => front.close(() => r()));
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("cache-control relay (S233 2a)", () => {
  it("a settled /feed page's cache-control reaches the caller, body unchanged", async () => {
    for (const q of ["?before=MTcwMC44NDUzLjEuMC4y", "?at=1750000000", "?at=8453:1&limit=5"]) {
      const r = await fetch(`${url}/feed${q}`);
      expect([r.status, r.headers.get("cache-control"), await r.text()], q).toEqual([200, HISTORY, FEED]);
    }
  });
  it("where the reader sets none, the front adds none: the now-edge /feed, GET /read, the tx door, /ready", async () => {
    for (const p of ["/feed", "/feed?limit=5", `/read/42161/${TEST}`, `/read/42161/tx/${HASH}`, "/ready"]) {
      const r = await fetch(`${url}${p}`);
      expect([r.status, r.headers.get("cache-control")], p).toEqual([200, null]);
    }
  });
});
