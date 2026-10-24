// One x402 payment from a grantee vault: the official client (@x402/fetch wrapFetchWithPayment over
// @x402/core x402Client with the @x402/evm exact scheme) and the SDK's vault signer adapter.
//
//   node --experimental-strip-types tools/pay-once.ts --account 0x… --grant-id 0x… --url http://127.0.0.1:4021/paid
//
// The grantee key is read from B2_GRANTEE_HOT_KEY and the RPC from ARB_ONE_RPC_URL; neither is ever printed
// or passed on the command line. validBefore = the live envelope's expiry, read from chain (R-B0-1).

import { parseArgs } from "node:util";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { decodePaymentResponseHeader } from "@x402/core/http";
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
const rpc = process.env.ARB_ONE_RPC_URL;
if (!key) throw new Error("B2_GRANTEE_HOT_KEY is not set");
if (!rpc) throw new Error("ARB_ONE_RPC_URL is not set");

const grantee = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpc) });
try {
  const p = await payInsideGrant({
    publicClient,
    account: values.account as Address,
    grantId: values["grant-id"] as Hex,
    token: values.token as Address,
    grantee,
  });
  console.log(`grantee ${grantee.address} vault ${p.vault} validBefore ${p.validBefore}`);
  const res = await p.fetch(values.url!);
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
  let msg = String(e instanceof Error ? e.message : e).split(rpc).join("<ARB_ONE_RPC_URL>");
  const host = URL.canParse(rpc) ? new URL(rpc).host : "";
  if (host) msg = msg.split(host).join("<rpc-host>");
  console.error(msg);
  process.exit(1);
}
