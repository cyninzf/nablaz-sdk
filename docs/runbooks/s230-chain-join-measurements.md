# S230 chain join: measurements of record

The chain join adds OP Mainnet (10: SpendPermissionManager, DelegationManager) and Linea (59144: DelegationManager
only) to `packages/reader/src/chains.ts`. Every figure below was read on 2026-11-25, read-only (`eth_getCode`,
`eth_getLogs`, `eth_getBlock`, `eth_chainId`), on the existing Alchemy key of the Arbitrum grounding leg
(`CHAINS[42161].groundingRpcEnv`) at its `opt-mainnet` and `linea-mainnet` hosts. No transaction was sent.
From this join on, grantor-count results are committed here, not carried on a relay's word.

## OP-DM re-read (join gate)

Command, from `packages/reader`:

```
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/grantor-count.ts --days 30 dm@optimism
```

| | |
| --- | --- |
| Target | DelegationManager `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`, chain 10 |
| Bytecode gate (R-S226-7) | PASS: 11,503 bytes; differs from the indexed 8453 code at 34 bytes, all inside the mask (6797-6798, 6809-6840); chain id 10 and the EIP-712 domain separator ("DelegationManager" v1) VERIFIED on 8453, 42161 and 10 |
| Window | blocks 158713123..160009123, 2026-10-26T14:30:23Z .. 2026-11-25T14:30:23Z (30 days), 1 `eth_getLogs` call |
| Events | 1,623 `RedeemedDelegation` |
| Distinct grantors | **503** (distinct root delegators: 503) |
| Falsifier | under 500 distinct grantors / 30 days does not join: **CLEARS** (503 ≥ 500) |

The S226 results for `dm@linea` and `spm@optimism` were not committed at the time and are not restated here.

## Deployment blocks (`DEPLOYED` in `src/chains.ts`)

Method (the Polygon method): binary search on `eth_getCode` over [0, latest] for the first block with code,
confirmed by the block before it being empty; cross-checked against the first log the address emitted, found by a
forward `eth_getLogs` scan from that block. 90 `eth_getCode` and 6 `eth_getLogs` calls in all.

| Source | Chain | Deployment block | `eth_getCode` | First log |
| --- | --- | --- | --- | --- |
| DelegationManager | 10 | **133803172** (2025-03-28T23:38:41Z) | empty at 133803171; 11,503 bytes at 133803172 | same block: tx `0x835aafefbbcc5072ac320a76873169dfec237c5d03b249675cae5a16249c904b`, logIndex 75, topic0 `0x8be0079c…` (OwnershipTransferred) |
| SpendPermissionManager | 10 | **129095661** (2024-12-10T00:21:39Z) | empty at 129095660; 12,610 bytes at 129095661 | block 129214148: tx `0xbe1a4d3b1c8fd7ca9e4f88dbdb5eda3b7cb65fdb8e68a6277a3d9251a6795bc4`, logIndex 68, topic0 `0xff59e520…` |
| DelegationManager | 59144 | **17474505** (2025-03-29T00:40:15Z) | empty at 17474504; 11,503 bytes at 17474505 | same block: tx `0xd23a15a0a715899d6854587e39942d80b2e9974f7667bb5799eea1ff24141772`, logIndex 0, topic0 `0x8be0079c…` (OwnershipTransferred) |

As on Arbitrum and Base, the SpendPermissionManager's first log comes after its deployment block and the
DelegationManager's is in it.

## Linea SpendPermissionManager (scope check)

`eth_getCode` at `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` on Linea at block 32708039: empty. Linea carries the
DelegationManager only, per the join scope of record; nothing was added for the SpendPermissionManager there.
