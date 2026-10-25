// The mainnet seller (tools/seller.ts --cdp) loads @coinbase/cdp-sdk/x402, which imports its optional peers
// @x402/extensions and @x402/svm at module load. Without them the seller dies before serving a request.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @coinbase/cdp-sdk is a devDependency (the seller tool and this test only). Nothing the package exports
// may import it, statically or dynamically.
describe("dev-only packages stay out of src/", () => {
  const src = join(import.meta.dirname, "../../src");
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.[cm]?[jt]s$/.test(f));
  it("finds the source files", () => expect(files).toContain("vault-signer.ts"));
  it("@coinbase/cdp-sdk is pinned as a devDependency, not a dependency", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
    expect(pkg.dependencies["@coinbase/cdp-sdk"]).toBeUndefined();
    expect(pkg.devDependencies["@coinbase/cdp-sdk"]).toBe("1.58.0");
  });
  for (const f of files) {
    it(`src/${f} does not import @coinbase/cdp-sdk`, () => {
      expect(readFileSync(join(src, f), "utf8")).not.toMatch(/["'`]@coinbase\/cdp-sdk/);
    });
  }
});

describe("x402 entry points used by Phase 0", () => {
  it("@coinbase/cdp-sdk/x402 loads and exports createCdpFacilitatorClient", async () => {
    const m = await import("@coinbase/cdp-sdk/x402");
    expect(typeof m.createCdpFacilitatorClient).toBe("function");
    expect(m.CDP_FACILITATOR_URL).toBe("https://api.cdp.coinbase.com/platform/v2/x402");
  });
  it("the official seller, facilitator and client entry points load", async () => {
    const server = await import("@x402/core/server");
    const facilitator = await import("@x402/core/facilitator");
    const client = await import("@x402/core/client");
    expect(typeof server.x402ResourceServer).toBe("function");
    expect(typeof server.x402HTTPResourceServer).toBe("function");
    expect(typeof facilitator.x402Facilitator).toBe("function");
    expect(typeof client.x402Client).toBe("function");
    expect(typeof (await import("@x402/evm/exact/server")).ExactEvmScheme).toBe("function");
    expect(typeof (await import("@x402/evm/exact/facilitator")).ExactEvmScheme).toBe("function");
    expect(typeof (await import("@x402/evm/exact/client")).ExactEvmScheme).toBe("function");
    expect(typeof (await import("@x402/fetch")).wrapFetchWithPayment).toBe("function");
  });
});
