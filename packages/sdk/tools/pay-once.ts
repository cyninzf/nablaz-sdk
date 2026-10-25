// One x402 payment from a grantee vault: the official client (@x402/fetch wrapFetchWithPayment over
// @x402/core x402Client with the @x402/evm exact scheme) and the SDK's vault signer adapter.
//
//   node --experimental-strip-types tools/pay-once.ts --account 0x… --grant-id 0x… --url http://127.0.0.1:4021/paid
//
// The grantee key is read from B2_GRANTEE_HOT_KEY and the RPC from ARB_ONE_RPC_URL, falling back to
// READER_ARB_RPC_URL; the name used is printed, neither value is ever printed or passed on the command line. validBefore = min(live envelope expiry, now + the seller's
// maxTimeoutSeconds) (R-S186-1); the client prints the value it signed and the nonce.

import { parseArgs } from "node:util";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { payInsideGrant } from "../src/pay.ts";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    "grant-id": { type: "string" },
    url: { type: "string" },
    token: { type: "string", default: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  },
});
for (const k of ["account", "grant-id", "url"] as const) if (!values[k]) throw new Error(`--${k} is required`);
const key = process.env.B2_GRANTEE_HOT_KEY;
const rpcName = process.env.ARB_ONE_RPC_URL ? "ARB_ONE_RPC_URL" : "READER_ARB_RPC_URL";
const rpc = process.env[rpcName];
if (!key) throw new Error("B2_GRANTEE_HOT_KEY is not set");
if (!rpc) throw new Error("neither ARB_ONE_RPC_URL nor READER_ARB_RPC_URL is set");
console.log(`rpc from ${rpcName}`);

const grantee = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpc) });
// The PAYMENT-SIGNATURE header the client sends: authorization fields only are printed, never the signature.
let sent: string | null = null;
const capturing: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  sent = req.headers.get("payment-signature") ?? sent;
  return fetch(req);
};
try {
  const p = await payInsideGrant({
    publicClient,
    account: values.account as Address,
    grantId: values["grant-id"] as Hex,
    token: values.token as Address,
    grantee,
    fetch: capturing,
  });
  console.log(`grantee ${grantee.address} vault ${p.vault} envelope expiry ${p.expiry}`);
  const res = await p.fetch(values.url!);
  if (sent) {
    const sig = decodePaymentSignatureHeader(sent);
    const a = (sig.payload as { authorization: Record<string, string> }).authorization;
    console.log(`signed from ${a.from} to ${a.to} value ${a.value} validAfter ${a.validAfter} validBefore ${a.validBefore} nonce ${a.nonce} (seller maxTimeoutSeconds ${sig.accepted.maxTimeoutSeconds})`);
  }
  const header = res.headers.get("payment-response");
  console.log(`HTTP ${res.status}`);
  if (header) {
    const s = decodePaymentResponseHeader(header);
    console.log(`settlement success=${s.success} tx ${s.transaction} network ${s.network} payer ${s.payer}`);
  } else {
    console.log(`no PAYMENT-RESPONSE header; body: ${(await res.text()).slice(0, 300)}`);
  }
} catch (e) {
  // viem errors can carry the transport URL; print the message only, with the RPC URL and host removed.
  let msg = String(e instanceof Error ? e.message : e).split(rpc).join(`<${rpcName}>`);
  const host = URL.canParse(rpc) ? new URL(rpc).host : "";
  if (host) msg = msg.split(host).join("<rpc-host>");
  console.error(msg);
  process.exit(1);
}
