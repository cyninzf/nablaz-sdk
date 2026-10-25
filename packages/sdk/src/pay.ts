// Pay inside a grant: the official x402 client (@x402/core x402Client + @x402/evm exact scheme +
// @x402/fetch), unpatched, with the grantee vault as payer. Phase 0 scope: `exact` over EIP-3009 only —
// no upto, no batch-settlement, no Permit2.

import { getAddress, isAddressEqual, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { x402Client } from "@x402/core/client";
import type { PaymentPayloadContext, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { readVaultImpl, predictVault } from "./vault.ts";
import { granteeVaultSigner, maxValidBefore, ValidBeforeExceeded, type GranteeKey, type GranteeVaultSignerConfig } from "./vault-signer.ts";

export type EnvelopeSignerConfig = Omit<GranteeVaultSignerConfig, "maxTimeoutSeconds" | "expiry"> & {
  /** The live envelope's expiry, read from chain; called before every payment. Throws if the envelope is gone. */
  readEnvelopeExpiry: () => Promise<bigint>;
};

/**
 * The official exact client scheme, with validBefore = min(envelope expiry, now + the seller's
 * maxTimeoutSeconds) (R-S186-1).
 *
 * The official scheme sets validBefore = now + maxTimeoutSeconds. When the envelope ends inside the seller's
 * window it is handed a copy of the requirements whose maxTimeoutSeconds is (expiry − now), never more than
 * the seller's; otherwise the seller's own value. The requirements the server sees in `accepted` are the
 * original ones (x402Client sets `accepted` itself). Each payment gets a signer bound to that seller window;
 * if the clock ticks between the two readings of `now` and the result would pass the envelope, the signer
 * refuses (ValidBeforeExceeded) and the payload is rebuilt. The envelope expiry is re-read before every
 * payment, so an envelope replaced or shortened since setup bounds the next payment.
 */
export function envelopeExactScheme(cfg: EnvelopeSignerConfig): SchemeNetworkClient {
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  // Only `scheme` and `findDefaultAsset` are read from this one; it never signs.
  const probe = new ExactEvmScheme(granteeVaultSigner({ ...cfg, expiry: 0n, maxTimeoutSeconds: 1 }));
  return {
    scheme: probe.scheme,
    findDefaultAsset: probe.findDefaultAsset,
    async createPaymentPayload(x402Version: number, requirements: PaymentRequirements, context?: PaymentPayloadContext) {
      if ((requirements.extra?.assetTransferMethod ?? "eip3009") !== "eip3009") {
        throw new Error(`asset transfer method ${String(requirements.extra?.assetTransferMethod)} is out of scope`);
      }
      const seller = requirements.maxTimeoutSeconds;
      const expiry = await cfg.readEnvelopeExpiry();
      const inner = new ExactEvmScheme(granteeVaultSigner({ ...cfg, expiry, maxTimeoutSeconds: seller, now }));
      for (let attempt = 0; ; attempt++) {
        const t = now();
        const timeout = Number(maxValidBefore(expiry, seller, t) - BigInt(t));
        if (timeout <= 6) throw new Error(`validBefore would be ${timeout} s away (envelope expiry ${expiry}, seller window ${seller} s); too late to pay`);
        try {
          return await inner.createPaymentPayload(x402Version, { ...requirements, maxTimeoutSeconds: timeout }, context);
        } catch (e) {
          if (!(e instanceof ValidBeforeExceeded) || attempt >= 2) throw e;
        }
      }
    },
  };
}

const accountAbi = parseAbi([
  "function dependencies() view returns (address mandate, address riskConfig, address encumbranceRegistry, address registry, address zkGate)",
]);
const camAbi = parseAbi([
  "function granteeOf(address account, bytes32 grantId) view returns (address wallet, bytes32 granteeKey)",
  "function envelopeOf(address account, bytes32 granteeKey, address token) view returns (bytes32 grantId, uint64 expiry)",
]);

export type GrantPayment = {
  account: Address;
  grantId: Hex;
  token: Address;
  vault: Address;
  granteeKey: Hex;
  /** The envelope expiry at setup. It is re-read before every payment; no validBefore is later (R-S186-1). */
  expiry: bigint;
  client: x402Client;
  fetch: typeof fetch;
};

/**
 * Everything a grantee needs to pay from its vault, read from chain: the grant's grantee key, the vault
 * (from the account's own VAULT_IMPL), and the live envelope's expiry. Refuses if the key is not the
 * grant's grantee or the envelope is not this grant's or has expired.
 */
export async function payInsideGrant(opts: {
  publicClient: PublicClient;
  account: Address;
  grantId: Hex;
  token: Address;
  grantee: GranteeKey;
  fetch?: typeof fetch;
}): Promise<GrantPayment> {
  const { publicClient: pc, grantId } = opts;
  const account = getAddress(opts.account);
  const token = getAddress(opts.token);
  const chainId = await pc.getChainId();
  const [mandate] = await pc.readContract({ address: account, abi: accountAbi, functionName: "dependencies" });
  const [wallet, granteeKey] = await pc.readContract({ address: mandate, abi: camAbi, functionName: "granteeOf", args: [account, grantId] });
  if (!isAddressEqual(wallet, opts.grantee.address)) throw new Error(`grant ${grantId}'s grantee is ${wallet}, not ${opts.grantee.address}`);
  const vault = predictVault(await readVaultImpl(pc, account), account, granteeKey);
  const readEnvelopeExpiry = async () => {
    const [envGrant, expiry] = await pc.readContract({ address: mandate, abi: camAbi, functionName: "envelopeOf", args: [account, granteeKey, token] });
    if (envGrant.toLowerCase() !== grantId.toLowerCase()) throw new Error(`the live envelope is grant ${envGrant}, not ${grantId}`);
    const { timestamp } = await pc.getBlock();
    if (BigInt(expiry) <= timestamp) throw new Error(`envelope expired at ${expiry}`);
    return BigInt(expiry);
  };
  const expiry = await readEnvelopeExpiry();
  const scheme = envelopeExactScheme({ grantee: opts.grantee, vault, grantId, token, chainId, readEnvelopeExpiry });
  const client = new x402Client().register(`eip155:${chainId}`, scheme);
  return { account, grantId, token, vault, granteeKey, expiry, client, fetch: wrapFetchWithPayment(opts.fetch ?? fetch, client) };
}
