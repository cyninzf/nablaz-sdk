// R-S205-6: GET /favicon.ico on the front serves the committed NablaZ icon (packages/mcp/static/nablaz-icon-256.png),
// image/png, long-cached. The pinned hash is the press-kit file's (nablaz.io/press-kit/nablaz-icon-256.png, 6,080
// bytes), checked before commit; nothing is fetched at runtime. Every other path stays 404, and no CORS header is sent.

import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAVICON_PATH, readHttpServer } from "../../src/http.ts";

const PINNED_SHA256 = "31af057a1a29bc52d27a1ae1f60e00a77afda024e9a23d4e020fa3c894308e97";

const server = readHttpServer({ readerUrl: "http://127.0.0.1:1" });
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("GET /favicon.ico", () => {
  it("200, image/png, immutable cache, and the body is the pinned icon", async () => {
    expect(FAVICON_PATH).toBe("/favicon.ico");
    const r = await fetch(`${base}/favicon.ico`, { headers: { origin: "https://example.com" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.length).toBe(6080);
    expect(createHash("sha256").update(body).digest("hex")).toBe(PINNED_SHA256);
  });

  it("only GET on that exact path serves it; neighbours stay 404", async () => {
    expect((await fetch(`${base}/favicon.ico`, { method: "POST" })).status).toBe(404);
    for (const p of ["/favicon.png", "/favicon.ico/x", "/FAVICON.ICO", "/apple-touch-icon.png", "/static/nablaz-icon-256.png", "/nablaz-icon-256.png"]) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(404);
    }
  });
});
