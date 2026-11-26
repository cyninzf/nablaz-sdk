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

## S232 post-ready reads (2026-11-26)

Release 20 (the S230 five-chain reindex, live schema `deployment-01m89nandm6z68gdjf7nfbbb9k`, build id `fe32cfae51`)
read on 2026-11-26 between 15:56 and 15:58Z, read-only, against `https://read.nablaz.io` with
`x-nablaz-caller: se`. The raw outputs are the assets of the draft release `s232-postready-*` (`feed.txt`,
`subjects.txt`, `door-reads.txt`), with a `SHA256SUMS` table.

### GET /feed (15:56:59Z)

Command, verbatim (node fetch, as in the Codespace):

```
node -e '(async()=>{const r=await fetch("https://read.nablaz.io/feed",{headers:{"x-nablaz-caller":"se"}});const j=await r.json();const it=j.items||j;const by={};for(const i of it){by[i.chainId]=(by[i.chainId]||0)+1}console.log("GET /feed",r.status,"items",it.length,"by chain",JSON.stringify(by),"keys",Object.keys(it[0]||{}).join(","));console.log(JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k])=>k!=="items"))).slice(0,400))})()'
```

| | |
| --- | --- |
| Status | 200, 100 items |
| Items by chain | 137: 46, 42161: 31, 8453: 23; none from 10 or 59144 (recency: the first page is the newest 100) |
| `asOfBlock` | 10: 160054918 · 137: 98002093 · 8453: 62591196 · 42161: 527768853 · 59144: 32717581 |

### Subjects read (15:57:18Z)

The newest DelegationManager row per chain, from an ephemeral console (R-S194-7 form, `statement_timeout` 20 s;
exactly one machine after), in the feed key's order. The console script's loop, verbatim (`col` is `subject` for
`external_permissions`, `payer` for `external_payments`):

```
for (const ch of [42161, 8453, 137, 10, 59144]) for (const t of ["external_permissions", "external_payments"]) {
  const col = t === "external_permissions" ? "subject" : "payer";
  const r = await c.query(`select ${col} as addr, block_number::text, source, tx_hash from "${sch}".${t} where chain_id=$1 order by block_timestamp desc, chain_id desc, block_number desc, log_index desc limit 1`, [ch]);
  console.log(JSON.stringify({ chain: ch, table: t, ...r.rows[0] }));
}
```

(`external_payments` with `payer` gave the same address and tx on each chain.)

| Chain | Subject | Block | Tx |
| --- | --- | --- | --- |
| 42161 | `0xfddc57f64f1a9ad47483d61a6f39510401c08629` | 527768383 | `0xee21ee4629f25c945fdc67937bba108a75d3090026d1d618108c8afb86b28f2f` |
| 8453 | `0xd8a434a5e5e3c7dde36ae0fa42d497627c763ff6` | 62591157 | `0xe7d9fbfece62d26395309783adabe5045ef09345fc97e51cb3eeeb8c8a2e3c7f` |
| 137 | `0xd7c2786829286186c5ef74f919045611eeca6c48` | 98002084 | `0x715facbb01a568c417d18bd0e39d146b80d1d8fefad4734ac4945ee4d0234355` |
| 10 | `0x4141f34b2b032e0cd960b6bb4636ec9cd5c52828` | 160053620 | `0xe341df4e2f2bd9ad62102005e350474b9f4cc73c17f51d2f2e3e6885277b9529` |
| 59144 | `0xd8a192e25c8981404b797350dc1abdc5dc064f79` | 32717380 | `0x8450ef8c4a11ad02da578cae88cc5642031fef8bd51d507ff4513ccda716fe64` |

### Door reads at each chain's own height (completed 15:57:31Z)

Command, verbatim (the `subs` map is the table above: subject, then tx; `x-nablaz-caller: se`; a 503 retried after
5 s up to 12 times, none needed; facts counted by `source`):

```
node -e '
const subs={42161:["0xfddc57f64f1a9ad47483d61a6f39510401c08629","0xee21ee4629f25c945fdc67937bba108a75d3090026d1d618108c8afb86b28f2f"],8453:["0xd8a434a5e5e3c7dde36ae0fa42d497627c763ff6","0xe7d9fbfece62d26395309783adabe5045ef09345fc97e51cb3eeeb8c8a2e3c7f"],137:["0xd7c2786829286186c5ef74f919045611eeca6c48","0x715facbb01a568c417d18bd0e39d146b80d1d8fefad4734ac4945ee4d0234355"],10:["0x4141f34b2b032e0cd960b6bb4636ec9cd5c52828","0xe341df4e2f2bd9ad62102005e350474b9f4cc73c17f51d2f2e3e6885277b9529"],59144:["0xd8a192e25c8981404b797350dc1abdc5dc064f79","0x8450ef8c4a11ad02da578cae88cc5642031fef8bd51d507ff4513ccda716fe64"]};
const get=async(p)=>{let n503=0;for(let i=0;i<12;i++){const r=await fetch("https://read.nablaz.io"+p,{headers:{"x-nablaz-caller":"se"}});if(r.status===503){n503++;await new Promise(r=>setTimeout(r,5000));continue}return {s:r.status,j:await r.json(),n503}}return {s:503,n503}};
(async()=>{for(const [ch,[a,tx]] of Object.entries(subs)){
const r=await get(`/read/${ch}/${a}`);const f=r.j?.facts||[];const by={};for(const x of f)by[x.source||x.kind]=(by[x.source||x.kind]||0)+1;
console.log(`GET /read/${ch}/${a} -> ${r.s} (503 retries ${r.n503}) asOfBlock ${r.j?.asOfBlock} facts ${f.length} ${JSON.stringify(by)}`);
const t=await get(`/read/${ch}/tx/${tx}`);const tf=t.j?.facts||[];
console.log(`GET /read/${ch}/tx/${tx.slice(0,12)}… -> ${t.s} (503 retries ${t.n503}) asOfBlock ${t.j?.asOfBlock} facts ${tf.length} kinds ${[...new Set(tf.map(x=>x.source))].join(",")} subjectField-present ${tf.length?("subjectField" in tf[0]):"n/a"}`)}})()'
```

| Chain | `/read/<chain>/<subject>` | `asOfBlock` | Facts | `/read/<chain>/tx/<tx>` | Facts |
| --- | --- | --- | --- | --- | --- |
| 42161 | 200 | 527768949 | 6 (2 delegation, 2 redemption, 2 delegation_payment) | 200 | 3 |
| 8453 | 200 | 62591351 | 3 (1 / 1 / 1) | 200 | 3 |
| 137 | 200 | 98002114 | 241 (45 delegation, 45 redemption, 151 delegation_payment) | 200 | 4 |
| 10 | 200 | 160054934 | 3 (1 / 1 / 1) | 200 | 3 |
| 59144 | 200 | 32717584 | 39 (13 / 13 / 13) | 200 | 3 |

Each tx answer had the same `asOfBlock` as its subject read, and its facts' sources were `metamask:delegation`,
`metamask:redemption` and `metamask:delegation_payment`. No fact carried `subjectField`: the S231 tx-fact subject
was not yet deployed at this read.
