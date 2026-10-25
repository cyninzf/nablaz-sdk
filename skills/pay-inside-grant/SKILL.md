---
name: pay-inside-grant
description: Pay an x402 resource from inside a grant on a NablaZ account, from the grant's vault, within mandate, using the grantee key. Use when an agent holds a grantee key and must pay an HTTP 402 resource with the `exact` scheme.
---

# Pay inside a grant

An agent that holds a grantee key pays an x402 resource from the grant's vault, within mandate. The
payer is the grantee vault, not the agent's own address. The grantee key signs; the vault's ERC-1271
signature is what USDC checks. Scope: x402 `exact` over EIP-3009 `transferWithAuthorization` only. No
`upto`, no batch settlement, no Permit2.

## Prerequisites

- The NablaZ account address.
- The `grantId` of the grant on that account.
- A funded vault: the account holder has reserved funds into the grant's vault (`reservePayment`), which
  wrote a `PAY_AUTHORIZED` entry to the record.
- The grantee key in an environment variable. Never put it in a prompt, a log, a command-line argument
  or a file under version control. The examples below read `GRANTEE_PRIVATE_KEY`.
- An RPC URL for the chain, also from the environment (`RPC_URL` below). The setup reads the account,
  the mandate and the latest block.

## Calls

```ts
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { payInsideGrant } from "@nablaz/sdk";

const grantee = privateKeyToAccount(process.env.GRANTEE_PRIVATE_KEY as Hex);
const publicClient = createPublicClient({ chain: arbitrum, transport: http(process.env.RPC_URL) });

const p = await payInsideGrant({
  publicClient,
  account: "0x…" as Address, // the NablaZ account
  grantId: "0x…" as Hex,
  token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC on Arbitrum One
  grantee,
});
// p.vault, p.granteeKey, p.expiry: read from chain at setup.

const res = await p.fetch("https://seller.example/resource");
// 2xx: paid. The PAYMENT-RESPONSE header carries the settlement transaction hash.
```

`payInsideGrant` reads, from chain:

1. the account's mandate (`dependencies()`), then `granteeOf(account, grantId)`: the grant's grantee
   wallet and its grantee key;
2. the account's own `VAULT_IMPL()`, and from it the vault: `predictVault(VAULT_IMPL, account, granteeKey)`;
3. `envelopeOf(account, granteeKey, token)`: the current envelope's grantId and expiry.

It returns `p.fetch`, the official `@x402/fetch` wrapper over an `x402Client` with the envelope-bound
`exact` scheme registered for `eip155:<chainId>`. The envelope is re-read before every payment.
`validBefore` = min(envelope expiry, now + the seller's `maxTimeoutSeconds`).

An agent that brings its own signing path (a KMS or hardware key behind viem `toAccount`) can build the
signer directly with `granteeVaultSignerFromChain(publicClient, { grantee, account, granteeKey, vault,
grantId, token, chainId, expiry, maxTimeoutSeconds })`, which reads `VAULT_IMPL` itself, or with
`granteeVaultSigner({ …, vaultImpl })`. Both refuse a vault that does not derive from the account. Take
`granteeKey` from `granteeOf`, not from the grantee address: an agentId grant is keyed by its agentId
(`granteeKeyOf`).

## Refusals

Errors thrown by `payInsideGrant` (setup) reach the caller as thrown. Errors thrown while `p.fetch` builds
the payment are re-thrown by `@x402/fetch` as a plain `Error` whose message starts
`Failed to create payment payload: ` followed by the original message; match on the message there, not on
the class.

| Case | Where | What is thrown |
|---|---|---|
| The key is not the grant's grantee | setup | `Error`: `grant <grantId>'s grantee is <wallet>, not <address>` |
| The current envelope is another grant's | setup, and before each payment | `Error`: `the live envelope is grant <id>, not <grantId>` |
| The envelope has expired | setup, and before each payment | `Error`: `envelope expired at <expiry>` |
| Too little time left to pay | each payment | `Error`: `validBefore would be <n> s away (…); too late to pay` |
| validBefore above min(envelope expiry, now + seller `maxTimeoutSeconds`) | each payment | `ValidBeforeExceeded` (`got`, `max`) |
| The vault does not derive from (VAULT_IMPL, account, granteeKey) | signer construction | `VaultMismatch` (`got`, `expected`) |
| The account's vault implementation is v1 | setup / signer construction | `NeverPaymentTarget` (`impl`) |
| Permit2 or another transfer method requested | each payment | `Error`: `asset transfer method <m> is out of scope` |

`payInsideGrant` derives the vault itself, so `VaultMismatch` arises only on the external-signer path.

The account holder can kill the account, which pauses every grantee path. The SDK does not read the
kill state. A payment signed after a kill fails at the seller's facilitator, and `p.fetch` resolves with
HTTP 402 instead of throwing:

- refused on verify: no settlement was attempted; the `PAYMENT-REQUIRED` header's `error` field carries
  the facilitator's reason;
- failed on settle: the `PAYMENT-RESPONSE` header has `success: false` and an `errorReason`. Read the
  vault's USDC balance before concluding that nothing moved.

The reason strings are the facilitator's own. Treat any 402 after a payment attempt as a refusal and do
not retry in a loop.

The holder can also sweep the vault back to the account (`sweepGranteeVault`), which cancels what is left
in it.

## What the record shows

A settlement writes no `NablaRecord` entry. A payment's record is two parts:

- the `PAY_AUTHORIZED` `RecordEntry` the account wrote when it reserved funds into the vault (the
  reservation): `writerAuth` = grantId, `counterpartyAuth` = the vault, `asset`, `amount`;
- USDC's own `AuthorizationUsed(authorizer = vault, nonce)` and `Transfer(vault → payTo, value)` events
  in the settlement transaction (the settlement).

The reader pairs them: one `vault_payments` row per settlement, carrying the grant it drew against.

To cite a payment, cite both: the `PAY_AUTHORIZED` log (block, transaction hash, log index) and the USDC
settlement transaction hash and its block.
