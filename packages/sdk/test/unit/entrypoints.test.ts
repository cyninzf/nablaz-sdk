// The mainnet seller (tools/seller.ts --cdp) loads @coinbase/cdp-sdk/x402, which imports its optional peers
// @x402/extensions and @x402/svm at module load. Without them the seller dies before serving a request.

import { describe, expect, it } from "vitest";

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
