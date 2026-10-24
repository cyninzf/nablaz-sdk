# S186 B2 Phase 0 — first live x402 payment from a NablaZ account (Arbitrum One)

Produced, not executed. Every value below was derived from proto `4a38c373` and live reads at Arbitrum
block 517955000 (`grantNonce[TEST]` re-read as 0 at block 517972848), and the exact Block A and Block C
calldata was replayed byte for byte on a fork with the real grantee key (`runbook.fork.test.ts`; see the
S186-B2-P0b report). The CTO adapts the paths to the operator's machine and issues it.

| | |
|---|---|
| TEST account | `0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c` (NablaAccountV3_1, riskTier 0) |
| Holder (controller) | `0x8A6cec15736F3072Db75514815F7470f64dF0100`, Ledger path 1 = `m/44'/60'/1'/0/0` |
| Grantee hot key | `0xCc885831ef9B284E7D5F199A6f4f72D290CC0243` (Codespace secret `B2_GRANTEE_HOT_KEY`) |
| CAM V4 | `0x02D9bEfE43A9E375d5a8D2111a593A0c3d664DB2` |
| NablaRecord | `0x80E937f9DEf48060308Ee00EC279d8448d4775b0` |
| GranteeVaultV2 (impl) | `0x630963b04c992d912F26e9bEF8C9339b2c29aED0` |
| USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| payTo | `0x1633647e98534880807A4ea19862b9bb47a00645` |
| startTime | `1792800000` = 2026-10-24 00:00:00 UTC |
| expiry (grant and envelope) | `1793491200` = 2026-11-01 00:00:00 UTC |
| validBefore (R-S186-1) | min(envelope expiry, signing time + the seller's maxTimeoutSeconds); seller default 300 s |

## Derivations (deterministic)

```
scope       = keccak256(abi.encodePacked(USDC, bytes4(transfer(address,uint256)) = 0xa9059cbb))
            = 0x1ced0621fad0788f49e11efdfd1231c949cb61b4c53b8f39463b60d5f1c418db
              (GranteeVaultV2 L169-172 checks exactly this action key; CAM V4 _checkAction requires it in scope)
granteeKey  = keccak256(abi.encode(uint8(0), 0xCc885831ef9B284E7D5F199A6f4f72D290CC0243))      // CAM V4 granteeKeyOf, agentId 0
            = 0x2c2ed5dd86fb43ad5766dcfa4e33aaf46c79270badcd0d3a429c08741b69c8fa
grantId     = keccak256(abi.encode(uint256(42161), TEST, granteeKey, grantNonce[TEST]))       // CAM V4 grant(), L121
            with grantNonce[TEST] = 0 (read at block 517955000; Block A step 0 re-checks it)
            = 0xefc5e61448596750c570eac19e80354a2671c1ae063b963ed1db28fa3ab4be8f
vault       = AccountVaults.vaultOf(TEST.VAULT_IMPL() = GranteeVaultV2, granteeKey)
            = CREATE2(deployer TEST, salt granteeKey, EIP-1167 clone of 0x6309…aED0 with args abi.encode(TEST, granteeKey))
            = 0x46414CFb3F27735F2a9824abfb63699bF80ed001
              (equals TEST.granteeVault(granteeKey) read live at block 517955000, and the SDK's vaultOf)
```

If `grantNonce[TEST]` is not 0 at step 0, stop: the grantId above is wrong and Block C's calldata with it.

## Block A — operator, Mac, Ledger path 1 (holder): grant

Step 0, read-only checks:

```sh
cast call 0x02D9bEfE43A9E375d5a8D2111a593A0c3d664DB2 "grantNonce(address)(uint256)" 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c --rpc-url "$ARB_ONE_RPC_URL"   # expect 0
cast call 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c "controller()(address)" --rpc-url "$ARB_ONE_RPC_URL"                                           # expect 0x8A6cec15736F3072Db75514815F7470f64dF0100
cast call 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c "riskTier()(uint8)" --rpc-url "$ARB_ONE_RPC_URL"                                               # expect 0
```

Spec: grantee `0xCc88…0243`, agentId 0, expiry 1793491200, allowances
`[{USDC, periodAmount 2000000, periodDuration 0, startTime 1792800000, perTx 1000000, secondWindow (0,0)}]`,
counterparties `[0x1633…0645]`, scope `[0x1ced…18db]`, descriptors `[]`.

Calldata (`grant` selector `0x75b562de`):

```
0x75b562de0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000cc885831ef9b284e7d5f199a6f4f72d290cc02430000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ae6810000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000001000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000001e84800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006adbf50000000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000001633647e98534880807a4ea19862b9bb47a0064500000000000000000000000000000000000000000000000000000000000000011ced0621fad0788f49e11efdfd1231c949cb61b4c53b8f39463b60d5f1c418db0000000000000000000000000000000000000000000000000000000000000000
```

```sh
cast send 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c <calldata above> \
  --ledger --hd-path "m/44'/60'/1'/0/0" --rpc-url "$ARB_ONE_RPC_URL"
```

Read back:

```sh
cast call 0x02D9bEfE43A9E375d5a8D2111a593A0c3d664DB2 \
  "grantOf(address,bytes32)((address,uint256,uint256,bytes32,uint64,uint32,bool,bool,bytes32,((address,uint128,uint32,uint64,uint128,(uint128,uint32)),uint128,uint128,uint128)[],address[],bytes32[],(address,address)[]))" \
  0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c 0xefc5e61448596750c570eac19e80354a2671c1ae063b963ed1db28fa3ab4be8f --rpc-url "$ARB_ONE_RPC_URL"
cast call 0x02D9bEfE43A9E375d5a8D2111a593A0c3d664DB2 "granteeOf(address,bytes32)(address,bytes32)" \
  0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c 0xefc5e61448596750c570eac19e80354a2671c1ae063b963ed1db28fa3ab4be8f --rpc-url "$ARB_ONE_RPC_URL"
```

Expect: grantee `0xCc88…0243`, agentId 0, chainId 42161, granteeKey `0x2c2e…c8fa`, expiry 1793491200, version 1,
revoked false, killed false, the allowance above with spent 0 / remaining 2000000, counterparties `[0x1633…0645]`,
scope `[0x1ced…18db]`, no descriptors; `granteeOf` = (`0xCc88…0243`, `0x2c2e…c8fa`). One `RecordEntry`
GRANT_SET in the tx with writerAuth = grantId.

## Block B — operator funds the TEST account

Send **2.00 USDC** (native USDC `0xaf88…5831`, 2000000 units) to the TEST account
**`0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c`** from a wallet that is not a Safe owner. No calldata.

```sh
cast call 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 "balanceOf(address)(uint256)" 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c --rpc-url "$ARB_ONE_RPC_URL"   # expect 2000000
```

## Block C — operator, Mac, Ledger path 1 (holder): reserve

`reservePayment(grantId, USDC, 2000000, 1793491200)` (selector `0x6dbcfed9`):

```
0x6dbcfed9efc5e61448596750c570eac19e80354a2671c1ae063b963ed1db28fa3ab4be8f000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000001e8480000000000000000000000000000000000000000000000000000000006ae68100
```

```sh
cast send 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c <calldata above> \
  --ledger --hd-path "m/44'/60'/1'/0/0" --rpc-url "$ARB_ONE_RPC_URL"
```

Predicted vault: **`0x46414CFb3F27735F2a9824abfb63699bF80ed001`**. Read back:

```sh
cast call 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c "granteeVault(bytes32)(address)" 0x2c2ed5dd86fb43ad5766dcfa4e33aaf46c79270badcd0d3a429c08741b69c8fa --rpc-url "$ARB_ONE_RPC_URL"   # expect 0x46414CFb3F27735F2a9824abfb63699bF80ed001
cast call 0x02D9bEfE43A9E375d5a8D2111a593A0c3d664DB2 "envelopeOf(address,bytes32,address)(bytes32,uint64)" \
  0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c 0x2c2ed5dd86fb43ad5766dcfa4e33aaf46c79270badcd0d3a429c08741b69c8fa 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 --rpc-url "$ARB_ONE_RPC_URL"
  # expect (0xefc5…be8f, 1793491200)
cast call 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 "balanceOf(address)(uint256)" 0x46414CFb3F27735F2a9824abfb63699bF80ed001 --rpc-url "$ARB_ONE_RPC_URL"   # expect 2000000
cast call 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 "balanceOf(address)(uint256)" 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c --rpc-url "$ARB_ONE_RPC_URL"   # expect 0
```

`envelopeOf` returns (grantId, expiry) only; the envelope amount is the vault's USDC balance. One `RecordEntry`
PAY_AUTHORIZED in the tx: writerAuth grantId, counterparty `0xCc88…0243`, counterpartyAuth = the vault
(left-padded), asset USDC, amount 2000000.

## Block D — SE, Codespace: seller and one payment

Prerequisites: the Codespace has been reloaded so `B2_GRANTEE_HOT_KEY`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`
and an RPC are in the environment. The client reads `ARB_ONE_RPC_URL`, falling back to `READER_ARB_RPC_URL`
(the Codespace has only the latter), and prints which name it used; the seller reads no RPC (CDP verifies and
settles). None is passed on a command line or printed. Packages:
`@x402/core`, `@x402/evm`, `@x402/fetch` 2.28.0, `@coinbase/cdp-sdk` 1.58.0, unpatched (lockfile).

```sh
cd packages/sdk
# Seller: official x402ResourceServer + exact scheme, CDP hosted facilitator (createCdpFacilitatorClient reads
# CDP_API_KEY_ID / CDP_API_KEY_SECRET from the environment). Prints each settlement's tx hash.
node --experimental-strip-types tools/seller.ts --cdp --pay-to 0x1633647e98534880807A4ea19862b9bb47a00645 --price '$0.01' --port 4021 &

# Client: ONE request from the vault. validBefore = min(live envelope expiry 1793491200, now + the seller's
# maxTimeoutSeconds 300) = signing time + 300 (R-S186-1); the adapter refuses to sign anything later.
node --experimental-strip-types tools/pay-once.ts \
  --account 0x8E65fa412e14c1859a9a278fdEFDE89A3c15b11c \
  --grant-id 0xefc5e61448596750c570eac19e80354a2671c1ae063b963ed1db28fa3ab4be8f \
  --url http://127.0.0.1:4021/paid
```

The seller prints its maxTimeoutSeconds (300) and each settlement's tx hash. The client prints the RPC
variable name it used, the vault and envelope expiry (re-read from chain again just before signing), then the authorization it signed (from, to, value, validAfter 0, validBefore = signing time
+ 300, nonce, the seller's maxTimeoutSeconds), the HTTP status and the settlement tx hash; both tx hashes
match. Stop the seller after one settlement (`kill %1`).

## Expected on-chain outcome (CTO verifies)

In the settlement tx (`transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)`,
selector `0xcf092995`, `to` = USDC, submitted by CDP's facilitator):

1. USDC `AuthorizationUsed(authorizer = 0x46414CFb3F27735F2a9824abfb63699bF80ed001, nonce)`, the nonce the client printed.
   The tx's `validBefore` argument is the value the client printed: ≤ 1793491200 and ≤ the signing time + 300.
2. USDC `Transfer(from = 0x4641…d001, to = 0x1633…0645, value = 10000)`, immediately after it.
3. The calldata ends with an ERC-8021 suffix: last 16 bytes `0x80218021802180218021802180218021`, preceded by a
   schema byte and a codes-length byte.
4. Balances after: payTo 10000, vault 1990000, TEST 0.
5. NablaRecord entries for the TEST account, by kind: ACCOUNT_OPENED (block 517860375, before this run),
   GRANT_SET (Block A), PAY_AUTHORIZED (Block C). The settlement itself writes **no** NablaRecord entry.
6. B1 reader: a `vaults` row for `0x4641…d001` (create2_matches true, funding_transfer_seen true) and one
   `vault_payments` row paired from the two USDC events: payee `0x1633…0645`, value 10000, grant_id_from_logs
   = grantId, envelope_status determinate, envelope_expiry 1793491200. Pairing is by events only; calldata
   length and the suffix play no part.

## Failure branches — each: stop and report verbatim

- **CDP verify refuses the vault** (the seller prints `verify REFUSED` and the facilitator's reason: payer
  screening, `invalid_exact_evm_payload_signature` / ERC-1271, a simulation failure, or a validBefore-range
  rule on the hosted side — validBefore here is the seller's own window, signing time + 300, as the official
  client would sign it; the hosted facilitator's upper bound was not observed). Nothing has moved. Report the
  full seller and client output.
- **The client refuses to sign** (`ValidBeforeExceeded` or `too late to pay`): the clock or the envelope is
  off; nothing was sent. Report the client output and `date -u`.
- **CDP settle fails after verify** (`settle FAILED: <reason>`): read the vault's USDC balance and
  `authorizationState(vault, nonce)` on USDC before anything else; report both with the output.
- **The record read-back disagrees with the chain** (grantOf / granteeOf / envelopeOf / granteeVault / the
  RecordEntry fields differ from the expectations above): stop before the next block.

Cancel path at any point (holder, path 1): `sweepGranteeVault(granteeKey, USDC)` returns the vault's USDC to
the TEST account and writes VAULT_SWEPT; `kill()` pauses every grantee path.

```
sweepGranteeVault calldata: 0x41e7ec932c2ed5dd86fb43ad5766dcfa4e33aaf46c79270badcd0d3a429c08741b69c8fa000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831
kill calldata:              0x41c0e1b5
```
