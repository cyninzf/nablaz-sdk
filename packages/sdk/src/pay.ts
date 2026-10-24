// Pay inside a grant: the official x402 client (@x402/core x402Client + @x402/evm exact scheme +
// @x402/fetch), unpatched, with the grantee vault as payer. Phase 0 scope: `exact` over EIP-3009 only —
// no upto, no batch-settlement, no Permit2.

import { getAddress, isAddressEqual, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { x402Client } from "@x402/core/client";
import type { PaymentPayloadContext, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { readVaultImpl, predictVault } from "./vault.ts";
import { granteeVaultSigner, ValidBeforeMismatch, type GranteeKey } from "./vault-signer.ts";

/**
 * The official exact client scheme, with validBefore landing on the envelope expiry (R-B0-1).
 *
 * The official scheme sets validBefore = now + maxTimeoutSeconds, so it is handed a copy of the
 * requirements whose maxTimeoutSeconds is (validBefore − now). The requirements the server sees in
 * `accepted` are the original ones (x402Client sets `accepted` itself). If the clock ticks between the two
 * readings of `now`, the signer refuses (ValidBeforeMismatch) and the payload is rebuilt.
 */
export function envelopeExactScheme(signer: ClientEvmSigner, validBefore: bigint, now = () => Math.floor(Date.now() / 1000)): SchemeNetworkClient {
  const inner = new ExactEvmScheme(signer);
  return {
    scheme: inner.scheme,
    findDefaultAsset: inner.findDefaultAsset,
    async createPaymentPayload(x402Version: number, requirements: PaymentRequirements, context?: PaymentPayloadContext) {
      if ((requirements.extra?.assetTransferMethod ?? "eip3009") !== "eip3009") {
        throw new Error(`asset transfer method ${String(requirements.extra?.assetTransferMethod)} is out of scope`);
      }
      for (let attempt = 0; ; attempt++) {
        const timeout = Number(validBefore) - now();
        if (timeout <= 6) throw new Error(`envelope expires at ${validBefore}; too late to pay`);
        try {
          return await inner.createPaymentPayload(x402Version, { ...requirements, maxTimeoutSeconds: timeout }, context);
        } catch (e) {
          if (!(e instanceof ValidBeforeMismatch) || attempt >= 2) throw e;
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
  /** The envelope expiry; every authorization's validBefore. */
  validBefore: bigint;
  signer: ClientEvmSigner;
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
  const [envGrant, expiry] = await pc.readContract({ address: mandate, abi: camAbi, functionName: "envelopeOf", args: [account, granteeKey, token] });
  if (envGrant.toLowerCase() !== grantId.toLowerCase()) throw new Error(`the live envelope is grant ${envGrant}, not ${grantId}`);
  const { timestamp } = await pc.getBlock();
  if (BigInt(expiry) <= timestamp) throw new Error(`envelope expired at ${expiry}`);
  const validBefore = BigInt(expiry);
  const signer = granteeVaultSigner({ grantee: opts.grantee, vault, grantId, token, chainId, validBefore });
  const client = new x402Client().register(`eip155:${chainId}`, envelopeExactScheme(signer, validBefore));
  return { account, grantId, token, vault, granteeKey, validBefore, signer, client, fetch: wrapFetchWithPayment(opts.fetch ?? fetch, client) };
}
