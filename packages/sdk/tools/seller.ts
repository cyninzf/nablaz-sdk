// Minimal x402 v2 seller: the official resource server (@x402/core/server x402ResourceServer +
// x402HTTPResourceServer, @x402/evm/exact/server ExactEvmScheme) behind node:http. Unpatched; this file
// only adapts node's request object to the official HTTPAdapter.
//
// Mainnet (Phase 0 live check 2), CDP's hosted facilitator; the CDP key is read from CDP_API_KEY_ID /
// CDP_API_KEY_SECRET by @coinbase/cdp-sdk and never passed on the command line or printed:
//   node --experimental-strip-types tools/seller.ts --cdp --pay-to 0x… [--price '$0.01'] [--port 4021]
//
// Prints the settlement tx hash of every request it settles, and nothing secret.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
} from "@x402/core/server";
import type { Network, Price } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";

export type SellerRoute = { path: string; payTo: string; price: Price };

/** What the seller saw for one paid request, in order. */
export type SellerEvent = {
  path: string;
  verified: boolean;
  /** processHTTPRequest's refusal, when verify failed (the facilitator's invalidReason is in the body). */
  refusal?: { status: number; body: unknown };
  settle?: { success: boolean; transaction?: string; errorReason?: string; payer?: string };
};

export type Seller = { url: string; events: SellerEvent[]; close: () => Promise<void> };

export async function startSeller(opts: {
  facilitator: FacilitatorClient;
  network: Network;
  routes: SellerRoute[];
  port?: number;
  maxTimeoutSeconds?: number;
}): Promise<Seller> {
  const resourceServer = new x402ResourceServer(opts.facilitator).register(opts.network, new ExactEvmScheme());
  const http = new x402HTTPResourceServer(
    resourceServer,
    Object.fromEntries(
      opts.routes.map((r) => [
        `GET ${r.path}`,
        {
          accepts: { scheme: "exact", network: opts.network, payTo: r.payTo, price: r.price, maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 300 },
          description: "Phase 0 test resource",
          mimeType: "application/json",
        },
      ]),
    ),
  );
  await http.initialize();
  const events: SellerEvent[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const header = (n: string) => {
      const v = req.headers[n.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const adapter: HTTPAdapter = {
      getHeader: header,
      getMethod: () => req.method ?? "GET",
      getPath: () => url.pathname,
      getUrl: () => url.toString(),
      getAcceptHeader: () => header("accept") ?? "",
      getUserAgent: () => header("user-agent") ?? "",
    };
    const ctx: HTTPRequestContext = { adapter, path: url.pathname, method: req.method ?? "GET", paymentHeader: header("payment-signature") };
    const r = await http.processHTTPRequest(ctx);
    if (r.type === "no-payment-required") {
      res.writeHead(404).end();
      return;
    }
    if (r.type === "payment-error") {
      if (ctx.paymentHeader) events.push({ path: url.pathname, verified: false, refusal: { status: r.response.status, body: r.response.body } });
      res.writeHead(r.response.status, r.response.headers).end(r.response.body === undefined ? "" : JSON.stringify(r.response.body));
      return;
    }
    const s = await http.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions, { request: ctx });
    events.push({
      path: url.pathname,
      verified: true,
      settle: { success: s.success, transaction: s.transaction, errorReason: s.success ? undefined : s.errorReason, payer: s.payer },
    });
    if (s.success) {
      res.writeHead(200, { ...s.headers, "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(402, { ...s.headers, "content-type": "application/json" }).end(JSON.stringify({ error: s.errorReason }));
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500).end(String(e instanceof Error ? e.message : e).slice(0, 300));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    events,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── CLI (mainnet live check) ─────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      cdp: { type: "boolean", default: false },
      "pay-to": { type: "string" },
      price: { type: "string", default: "$0.01" },
      port: { type: "string", default: "4021" },
      path: { type: "string", default: "/paid" },
    },
  });
  if (!values.cdp) throw new Error("only --cdp is supported from the command line (fork runs use startSeller)");
  if (!values["pay-to"]) throw new Error("--pay-to is required");
  const { createCdpFacilitatorClient } = await import("@coinbase/cdp-sdk/x402");
  // Reads CDP_API_KEY_ID / CDP_API_KEY_SECRET from the environment.
  const facilitator = createCdpFacilitatorClient();
  const seller = await startSeller({
    facilitator,
    network: "eip155:42161",
    routes: [{ path: values.path!, payTo: values["pay-to"], price: values.price! }],
    port: Number(values.port),
  });
  console.log(`seller listening on ${seller.url}${values.path} (eip155:42161, exact, ${values.price}, payTo ${values["pay-to"]})`);
  let seen = 0;
  setInterval(() => {
    for (; seen < seller.events.length; seen++) {
      const e = seller.events[seen]!;
      if (e.settle?.success) console.log(`settled tx ${e.settle.transaction} payer ${e.settle.payer}`);
      else if (e.settle) console.log(`settle FAILED: ${e.settle.errorReason}`);
      else console.log(`verify REFUSED: ${JSON.stringify(e.refusal)}`);
    }
  }, 500);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
