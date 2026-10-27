# B4 part 1: step-0 premise record

The premises for the B4 part 1 reader (external sources and the read API), each proved on Arbitrum One and
Base before any code was built. The rulings are cited by number from nablaz-protocol
`docs/architecture/stack3-system-v3.md` §6.4a at `4ace372840989469430996afd7f4668cab046e8e` and the S189
relays; they are not restated here.

The tables for P0-3, P0-4 and P0-6 come from one run of

```sh
cd packages/reader && node --experimental-strip-types scripts/premises.ts out.json
```

with `READER_ARB_RPC_URL` and `READER_BASE_RPC_URL` set. That run's output is committed beside this file
as `b4-part1-premises.json`. Arbitrum head 518759926, Base head 53160134.

## P0-1 Environment

Both RPC variables were present. nablaz-protocol was checked out at
`4ace372840989469430996afd7f4668cab046e8e`.

## P0-2 Base log reads

Through `READER_BASE_RPC_URL`, `eth_getLogs` for `RedeemedDelegation` (topic0
`0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873`) at DelegationManager
`0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` over blocks 53149530..53159529 (10,000 blocks) returned 870
logs. `eth_getCode` at the same address returned 11,503 bytes.

## P0-3 RedeemedDelegation, decoded

Twelve per chain, the latest in the window. "Transfers" counts ERC-20 `Transfer` logs from the delegator
or the root delegator in the same transaction (R-S189-5). Every redemption here is a single hop. Labels
are in `test/unit/labels.test.ts`, which asserts one for every fixture.

**Arbitrum One**, blocks 518754927..518759926:

| Block | Tx:log | Delegate | Delegator | Hop | Enforcers (table name) | Transfers |
|---|---|---|---|---|---|---|
| 518758411 | `0xe6dd7f54c89a1b70c802d4456fa0a2a0e9a8ffef74e3fd8244c6edb6dbbc1478`:3 | `0x0000000000000000000000000000000000000a11` | `0xAE90e0933E75aE33727a960839361A677A60FBe0` | root | LimitedCalls, ExactExecutionBatch, Redeemer | 1 |
| 518758620 | `0xab20e32de61fc21a21eb9dfe57f2b17b32746e2d676f59f76cbea17c511e94aa`:20 | `0x0000000000000000000000000000000000000a11` | `0x4170f8991954bCD12Dee88ED4bB2f6eFF9ba2DDA` | root | LimitedCalls, ExactExecution, Redeemer | 1 |
| 518758640 | `0xdd34cb012aacf38320894bc3ed38ee27bf35ef1de292d5cfa9b86fd8f8cebd73`:6 | `0x0000000000000000000000000000000000000a11` | `0x74C816Cf0eD62Bf3DB62983B659124FCeAb9a43e` | root | SpecificActionERC20TransferBatch, LimitedCalls | 1 |
| 518758702 | `0x9dfe64c035638a82ac420df80b5d850694e88c68eabb26d357e2d18038b776c6`:4 | `0xcB283631b9703aa9fAff58877905cf1AcB1A05e4` | `0xcB283631b9703aa9fAff58877905cf1AcB1A05e4` | root | NativeBalanceChange (decrease) | 0 |
| 518758895 | `0x57a7d9b807292fa56976763aabcde30e0b97c414b44806d4f729c1d472436479`:15 | `0x0000000000000000000000000000000000000a11` | `0x4170f8991954bCD12Dee88ED4bB2f6eFF9ba2DDA` | root | LimitedCalls, ExactExecution, Redeemer | 1 |
| 518758967 | `0x9c38d30ac358c627c922a8f40ecf661f05cb3b6a571b1b7cad352e435cf86e43`:9 | `0x0000000000000000000000000000000000000a11` | `0xe15B49c98CB94498D3109Ba682a3af16b132bA51` | root | LimitedCalls, Timestamp, Redeemer, ExactExecution | 1 |
| 518759190 | `0xffc1006c54adce8526816e6673297719e8f047d8b956c3306ff09f447937da39`:5 | `0x0000000000000000000000000000000000000a11` | `0x930919E48B45BfbD56d2CE8e65bc648e4c8FC821` | root | LimitedCalls, ExactExecutionBatch, Redeemer | 1 |
| 518759489 | `0xec9c7fb6f5d47cdaae7cacdab0c795e8c004350e1e2062c4078808fa6320bd19`:8 | `0x0000000000000000000000000000000000000a11` | `0xb5651d6cf64d8E8ee28fA9E32bfdb4C222bf8129` | root | SpecificActionERC20TransferBatch, LimitedCalls | 1 |
| 518759543 | `0xeb4582e7bb0d55a45cc704c8ba86f8bb066cbc045901a7ab282b00c11cff8614`:7 | `0x0000000000000000000000000000000000000a11` | `0xb5651d6cf64d8E8ee28fA9E32bfdb4C222bf8129` | root | SpecificActionERC20TransferBatch, LimitedCalls | 1 |
| 518759634 | `0x8fc88f69586f6f6853f03c6eea674cf8abba27d9590d807c7b72428dd40c5906`:2 | `0x0000000000000000000000000000000000000a11` | `0x4c422DB7e7FaCd30B28B995556948aB7CDcdb066` | root | LimitedCalls, ExactExecution | 1 |
| 518759681 | `0xc7cca23a01e0d5082872409e0445b535309e4cc06546e0290f34bcc21031285a`:8 | `0x0000000000000000000000000000000000000a11` | `0x4a6a0073382d3f44b2a32720dd5795D9B7A74B04` | root | LimitedCalls, ExactExecution, Redeemer | 1 |
| 518759884 | `0xe75b7e7146ea4da3c93e662c8214120191b15576a7c7a8efdcae74625be92cf9`:7 | `0x0000000000000000000000000000000000000a11` | `0x900B26E6a00ebe15c9692c4889CA2BD40e4E1b7a` | root | SpecificActionERC20TransferBatch, LimitedCalls, Redeemer | 2 |

**Base**, blocks 53155135..53160134:

| Block | Tx:log | Delegate | Delegator | Hop | Enforcers (table name) | Transfers |
|---|---|---|---|---|---|---|
| 53160025 | `0x7a940f6d9bd84edd5d5909b829096d2d7b6f94d2da9a54520e1e7923a54ed063`:237 | `0x0000000000000000000000000000000000000a11` | `0xcaf770Cbb4d95EdDCd963538d2394165E5906532` | root | SpecificActionERC20TransferBatch, LimitedCalls | 1 |
| 53160045 | `0x219d9d6572b34d525f3c142e605baa302c34689e17a22a23c072ff89c0459782`:311 | `0x0000000000000000000000000000000000000a11` | `0xcc2176e410aa65065156D39279Bf76649Fcc9b31` | root | LimitedCalls, Timestamp, Redeemer, ExactExecutionBatch | 2 |
| 53160047 | `0xe25d05788d4c05fcf500a84b60298e2ee2de99981fa6a7447254da8b48de41da`:469 | `0x0000000000000000000000000000000000000a11` | `0x92397432579b91B6De49f0f14AfF64628912667D` | root | LimitedCalls, ExactExecutionBatch | 2 |
| 53160065 | `0x93774af1f00d8a2f4d7511589f4147c2628f088bc38dd5520c1f3065ebb55dc2`:660 | `0x0000000000000000000000000000000000000a11` | `0x92397432579b91B6De49f0f14AfF64628912667D` | root | LimitedCalls, ExactExecutionBatch | 3 |
| 53160081 | `0x19c3dfe9edf7eae156f26c936a059a535bcac1e8625c7195229b3927754e8e84`:113 | `0x0000000000000000000000000000000000000a11` | `0x7838450D39ad8f9bB41F4d229f7d32408718E97b` | root | ExactExecution, LimitedCalls | 1 |
| 53160099 | `0x9f839882543833cdb31a4caf7114fbc7776294e28702ce7ad7920f9e00d38e84`:289 | `0x0000000000000000000000000000000000000a11` | `0x92397432579b91B6De49f0f14AfF64628912667D` | root | LimitedCalls, ExactExecutionBatch | 2 |
| 53160102 | `0x8933f1ed90df4969103392bf84e14d47c99f979edc3197e7f0c424c1fcc2e643`:747 | `0x0000000000000000000000000000000000000a11` | `0x5699A1C6724DCa1E89f5E0273F0D490795771361` | root | SpecificActionERC20TransferBatch, LimitedCalls | 1 |
| 53160108 | `0xf1a66ed187c2792b26ac5519831dd225bef2773731a78b8d7c18a7d6f80cf26f`:118 | `0x0000000000000000000000000000000000000a11` | `0x5699A1C6724DCa1E89f5E0273F0D490795771361` | root | SpecificActionERC20TransferBatch, LimitedCalls | 1 |
| 53160111 | `0x7e9887131cc9db2e54061dbc88e83d11db41b6c6919950ad0da81ef426d20068`:229 | `0x0000000000000000000000000000000000000a11` | `0x36233a76D0794aB43ecd6C1aad81feD8f245B9B2` | root | SpecificActionERC20TransferBatch, LimitedCalls | 1 |
| 53160113 | `0x6f4596d1c1ba8f8928b576fb07ed9350f86b18d3b8d61d724162b2fecdcb44e9`:439 | `0x0000000000000000000000000000000000000a11` | `0x5A558786753494B24Df1e07fa877a5c34A2A4C3f` | root | LimitedCalls, Timestamp, ExactExecution | 1 |
| 53160126 | `0x5665950ff828dc79a6a7ab52f0203f48f360b6438de181b8ec51e71f7bcd1b46`:652 | `0x0000000000000000000000000000000000000a11` | `0x3AbEB2572bb4DA7F95eb244b36D420C80b821D1D` | root | LimitedCalls, ExactExecutionBatch, Redeemer | 1 |
| 53160127 | `0xde725607cea8edb0cffc561a5ed908986e1e0a4849523355c2e2b5db79135e71`:274 | `0x0000000000000000000000000000000000000a11` | `0x92397432579b91B6De49f0f14AfF64628912667D` | root | LimitedCalls, ExactExecutionBatch | 3 |

**Which delegation the event carries.** DelegationManager emits one `RedeemedDelegation` per delegation in
the chain, leaf first. Every one carries the root delegator as topic1 (`src/DelegationManager.sol:298-304`
at `bfbdf9795a976833ed2fa000baf42fbb83958b03`). The root has `authority` = `ROOT_AUTHORITY` (0xff…ff).
Every other hop's `authority` is the hash of its parent. Verified on Base tx
`0xcc399fad3554f9c7e42f465124c8114b42a420140647b178c03ae3217a22562e`:

- Log 352 is the leaf. Its delegator is `0xd26C540A8265b2f90F27B6639fa2D7AceA9C5D24`, its delegate is
  `ANY_DELEGATE` and its `authority` is `0x7d15294f…c484`.
- Log 353 is the root. Its delegator is `0xFd09e307728cD6cEe3009a4fA8e7138F064142Fa` and its `authority` is
  `ROOT_AUTHORITY`. Its delegation hash, computed by `delegationHash` (`EncoderLib` at the same commit), is
  `0x7d15294f…c484`.
- The only ERC-20 `Transfer` from a delegator in that tx is from the root (1000 units).

Over a wider scan, the last 2,000,000 Arbitrum blocks held no multi-hop redemption, and the last 200,000
Base blocks held 17.

**Open delegations** use `ANY_DELEGATE` = `0x0000000000000000000000000000000000000a11`
(`src/DelegationManager.sol:41`), not `address(0)`. Over the same wide scan, Arbitrum had `ANY_DELEGATE`
15,783 times, a named delegate 1,277 times and `address(0)` never. Base had `ANY_DELEGATE` 10,606 times and
a named delegate 2,937 times.

## P0-4 SpendPermissionManager

`SpendPermissionUsed` has four topics and indexes the account in topic2. `SpendPermissionApproved` and
`SpendPermissionRevoked` have two topics and index only `hash` (s3 §11.14 #3). For those two, the account
is the first word of the `SpendPermission` struct in `data`. Because the struct is dynamic, `data` starts
with a 32-byte offset word, so the account is the word at byte offset 32: hex characters `data[66:130]`,
as in the §6.4b (4) line. Every Approved and Revoked row below matches its decoded account at that offset.

**Arbitrum One**: Used

| Block | Tx:log | Topics | Account | Terms |
|---|---|---|---|---|
| 512282118 | `0x62adb710ee2f4748887ab390b627c83eafc7adefd5f9c593fc27b5de5e1f9c71`:2 | 4 | `0x5b272b203eEDC60434BAD315b01Cd1c5Dc89f3c0` | spender `0x94c6E8a48A8fD90a285240EE27d9EE1FaBE521aB`, spend 50000 |
| 512284997 | `0x66d97043d35deaee4e23f4924fdf64dbd17bc370b57a02e70f86ee2565bb0cd3`:31 | 4 | `0x5b272b203eEDC60434BAD315b01Cd1c5Dc89f3c0` | spender `0x94c6E8a48A8fD90a285240EE27d9EE1FaBE521aB`, spend 20000 |
| 512411893 | `0xb46fd5cce3329ca5f47a0ef56e4d055a0b9edff4d488a18e715e77ef7b4a9ed3`:2 | 4 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | spender `0xB396805F4C4eb7A45E237A9468FB647C982fBeb1`, spend 100000 |
| 515795464 | `0x494d7694d31f00a9e959c73d087d3636de0f592fe615838c12db6f9155208ed8`:2 | 4 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | spender `0xB396805F4C4eb7A45E237A9468FB647C982fBeb1`, spend 10000 |
| 515818959 | `0x4569953df98290adc8dc3cc3164d334ed5aca3592e4e3b9f33679b524f10a174`:45 | 4 | `0xc363Daa9e1dFfB6Ed08CE8621c1405eaC03Da15A` | spender `0xB396805F4C4eb7A45E237A9468FB647C982fBeb1`, spend 100000 |
| 515820232 | `0x46b607f8e0c5a7a936306679666d743bbb2472176822d8dc59e8c15812e59059`:20 | 4 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | spender `0xB396805F4C4eb7A45E237A9468FB647C982fBeb1`, spend 100000 |
| 516658369 | `0xef8cf1233d8fc8628c9f840ab547a168922675edb10b064013f3b2ed3d8c22b1`:5 | 4 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | spender `0xB396805F4C4eb7A45E237A9468FB647C982fBeb1`, spend 100000 |
| 516674270 | `0x7219245489061af097c390813d2682fef154c7d8d9ef97df5ad8916b710b742f`:11 | 4 | `0xd15Af96e50F7818bDF37E1296D7FeFbb64f105E0` | spender `0xB396805F4C4eb7A45E237A9468FB647C982fBeb1`, spend 1000000 |
| 517405922 | `0x311a1c00cdb64cbbbf18edefcaafdf9bc6241d97e779d0d254ff5ff891e9f616`:3 | 4 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | spender `0xB396805F4C4eb7A45E237A9468FB647C982fBeb1`, spend 100000 |
| 517694769 | `0x844eee77cdf272ca21596062e7f6810259204f61bd872387cf1b65e022afb8c0`:7 | 4 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | spender `0xB396805F4C4eb7A45E237A9468FB647C982fBeb1`, spend 100000 |

**Arbitrum One**: Approved, then Revoked

| Block | Tx:log | Topics | Account | Terms |
|---|---|---|---|---|
| 515800682 | `0x5b69ffb5c3dded174def2ff02488a65fb405b3c7cd87fbd1fce2f35c2cbdbfcf`:3 | 2 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | allowance 200000000, period 86400 s; data word 1 = account: true |
| 515802453 | `0x0deb1d1c7e9b79922316a7d2a08a22e1014d7c7db0c52cbf65586fb01d56e31a`:2 | 2 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | allowance 200000000, period 86400 s; data word 1 = account: true |
| 516492591 | `0x301f8a25eca51f1d59edea57f779b24e240a25520cb70dcb2e88c17624633dec`:11 | 2 | `0x66947CC78D184bF78D8a672ccBb3c6C2531d3D89` | allowance 50000000, period 86400 s; data word 1 = account: true |
| 515801970 | `0x65a049949acb08aed6f55d72aeb9fa153eedcbfcae32176d7f1e86d61e3f0d2b`:16 | 2 | `0x80d69a5A96274881B13aD93caa0C48081498948A` | allowance 200000000, period 86400 s; data word 1 = account: true |

**Base**: Used

| Block | Tx:log | Topics | Account | Terms |
|---|---|---|---|---|
| 53159477 | `0xeb420b8581052c42b141f1d4cd87dccee87e340a2d6b27a9dbdd4d60e0193890`:521 | 4 | `0x33248361B6Fe38243F5cF14E5471D92241F6eF57` | spender `0xf3DaAb8c050E60e9A89C074C927F60D5Fd9De9C0`, spend 798000 |
| 53159483 | `0xb44c5ec6f6923dbfe7b332c1f4bbe2331c97663da4a1ca2d6fc9b8a88ff70fd4`:79 | 4 | `0xFC9Cd96a5A530f543E08f3FEcc819C73294f82b4` | spender `0x771aD9c25B651D4a3fda8EABeeC75A8B08274ab8`, spend 970000 |
| 53159529 | `0x60fc4d73b57922741ee512b07daac358e03017237cfa3faecce5ff67c6ccdb53`:150 | 4 | `0x85363c5a6BD499Fa5B8EE10b96E14d92C9Bc26B3` | spender `0x930e35e63Bf1475bCf9dA82219352aC365AaF636`, spend 818000 |
| 53159565 | `0xf480dd4900d50c4201cdf075f4ba71ea3c6e335dc29f9c685542d6b83d0db292`:211 | 4 | `0x5DA31BFB03e191c4ebB366dC733902a9c7A83781` | spender `0x9E26f8F17B3573eb28ce8a300e9f9288920D9da6`, spend 822000 |
| 53159642 | `0xd461f7c8d82c76edee9ad8575519807adf3c1a77d084feed6dabedef67a4b809`:947 | 4 | `0x6019B97fc10A0A2705E6F2A9be08367b6CCA8adD` | spender `0x8b0105f141193AA89467C92e36CbdB1FBfb8F292`, spend 9990000 |
| 53159659 | `0x93dce45b752a5695f12b0e3bf18c69d7a682aea32c42a5fee9b1203738221256`:534 | 4 | `0x52E74Eb836D68a716Bd6a0a387d70b3015B8586a` | spender `0xD618960f6A7ee45dE921329109c344182727137E`, spend 890000 |
| 53159785 | `0x7c3c8b19af4cf9b93d4db150b0ee17ee227a7fe13a84419acc12d484a0fb3e86`:70 | 4 | `0xD2ded18f254539EF6d40146E6e3433DE9C6f6DF5` | spender `0x7E82Ad619a149db42aB305C655f2f8a96fd662bD`, spend 970000 |
| 53159836 | `0x8a3085acc3278bf5ca64ba2c48a4c733c363e2d9406ecfb51a10993c2d4fdfe7`:1383 | 4 | `0xCF34C6e887406De8a95c9947dd4634df3e667B33` | spender `0x40f83860A7c0EB91b817ea87d07d8E2fb386C3e9`, spend 1000000 |
| 53159997 | `0x7d3315e12fc4cac407684a8142527d9353bc31e2d8070bc8886c76bd44a8597c`:106 | 4 | `0x6A6B971A9Fa645110cC219C2838eB171212D00FC` | spender `0x411627F6C6dC5da036dDB78DB018D595F9dA2813`, spend 810000 |
| 53160037 | `0xc8abc90359c5a4e7c099d5f34d473d085dc8ab5a61df63782f7b7621132dcb91`:264 | 4 | `0x19e6498c9eBCff3Df309F9fe0db447C3465075E6` | spender `0x1DFE28d0E021a3CE35334F6a813eaC1eE1119A9d`, spend 970000 |

**Base**: Approved, then Revoked

| Block | Tx:log | Topics | Account | Terms |
|---|---|---|---|---|
| 53159156 | `0x3d8b59313b347595dd522a5e812f597be05ba6d91c35874ee402dcda75eae586`:516 | 2 | `0xcC52A83dDEfE21Db70872c0BA73685A663e2B670` | allowance 29990000, period 86400 s; data word 1 = account: true |
| 53159336 | `0xd3fee338f066209f143f81038bb15549a56391ead9c6b5e0377c035f125dfcb0`:972 | 2 | `0xdC0D7964Ad3B44F9867A2627AC76436016bC8F71` | allowance 17990000, period 86400 s; data word 1 = account: true |
| 53159636 | `0x189e4427b3ad1c59f8bff67f834dea9d363b606a88963f9f93a9e870e3e60713`:9 | 2 | `0x6019B97fc10A0A2705E6F2A9be08367b6CCA8adD` | allowance 9990000, period 86400 s; data word 1 = account: true |
| 52954114 | `0x3c30ad5056be6020a4b397805e3a092e7e2b054cbb766ee3d8121d999c11e821`:225 | 2 | `0x55b65Be661881b081Dd5C13261656BB65c9A772a` | allowance 9000000, period 2592000 s; data word 1 = account: true |

`SpendPermissionRevoked` is now seen on Base (block 52954114). s3 §11.14 #11 had found none in the 50,000
blocks it checked.

## P0-5 Enforcer table

Under R-S189-7 the table is pinned to MetaMask/delegation-framework main at
`b4b8c41fc912455a1af2300bfcd1276676b92a2e`, not to the v1.3.0 tag. It is built by `scripts/gen-enforcers.ts`
and committed as `packages/reader/src/generated/enforcers.json`:

- 42 rows: amount 12, exact-call 9, call-term 5, scope-only 15, wrapper 1.
- That is the 36 rows of s3 §6.4c, plus the five enforcers added at `b4b8c41f`.
- Plus the superseded `SpecificActionERC20TransferBatchEnforcer` at
  `0x00e0251aaA263dfE3B3541B758A82D1CBA1c3B6D`, marked "superseded by vendor at b4b8c41f".

This table is ahead of s3 §6.4c by those six rows until PE re-pins the proto side.

**The stop that led to R-S189-7.** At the v1.3.0 tag, one enforcer seen on chain was missing from the table:
`0x6649b61c873F6F9686A1E1ae9ee98aC380c7bA13`. It is the vendor's redeployed
`SpecificActionERC20TransferBatchEnforcer`, listed on main under the same "v1.3.0" heading. Its runtime is
3333 bytes; the superseded one's is 3279. The terms layout also changed (a `firstValue` word, minimum 124
bytes, not 92), so the decoder picks the layout per table row.

That one address made 28.6% of redemptions "(c) not determinable" at the v1.3.0 pin:

| Chain | Window | Redemptions | (c) at the v1.3.0 pin | (c) at `b4b8c41f` |
|---|---|---|---|---|
| Arbitrum One | last 2,000,000 blocks | 17,060 / 17,081 | 4,878 (`0x6649…`) | 0 |
| Base | last 200,000 blocks | 13,543 / 13,604 | 2,545 (`0x6649…`) + 1 (`0x29fc…`) | 1 (`0x29fc…`) |

Each figure pair is two scans taken minutes apart, so the windows differ slightly.

**Worked (c) example.** `0x29fcBBa852439616c4D614A2fa6411E42b760153` is on Base, in tx
`0xe2f861045f44fd86e15ca9d39656c1a8a714570bcd8214efd896a9d76bc9773a` log 516, block 52968199. It carries
1159 bytes of code and appears in no vendor list. The delegation's other caveats are AllowedTargets and
ValueLte, so without it the delegation would be "(a) allowance, per call". With it, precedence (1) of
R-S189-3 AMENDED 2 gives "(c) not determinable". The fixture is asserted in `test/unit/labels.test.ts` and
in R-S189-8 (iii) (`test/unit/enforcers.test.ts`).

## P0-6 Agent Credit Lines

`src/IAgentCreditLine.sol` at priors-agents/erc-agent-credit-lines main
`40a0d5661d9bf8d009d0f1426a55af2893cd56ba` is byte-identical to the file at
`1e386460fd18de10a2ae551579f0c290054413c6` cited in s3 §6.4b (6). The topic0s below were computed with
viem's `toEventSelector`, and `Borrowed` equals §6.4b (6). The scans filtered on topic only, with any
emitter, over the last 2,000,000 blocks.

| Event | topic0 | Blocks | Hits |
|---|---|---|---|
| Borrowed | `0x629355c554c974447ea37d858c9e39385b02dcfd05e66f0e83248b951e38fc43` | 516759927..518759926 | 0 |
| Repaid | `0xa7de81cb918e3d3d2e10d944b5a81f22d525eab1b926370283d4b9e997d445bb` | 516759927..518759926 | 0 |
| Defaulted | `0xea69a7290a8c5d33d720c1f1d3c299e3dd66d74e4ee6e570048e59068d9b04df` | 516759927..518759926 | 0 |
| Borrowed | `0x629355c554c974447ea37d858c9e39385b02dcfd05e66f0e83248b951e38fc43` | 51160135..53160134 | 0 |
| Repaid | `0xa7de81cb918e3d3d2e10d944b5a81f22d525eab1b926370283d4b9e997d445bb` | 51160135..53160134 | 0 |
| Defaulted | `0xea69a7290a8c5d33d720c1f1d3c299e3dd66d74e4ee6e570048e59068d9b04df` | 51160135..53160134 | 0 |

The first three rows are Arbitrum One and the last three are Base. Every scan is empty, and an empty read
is a valid result (R-S189-6). The decoder ships with synthetic fixtures: Borrowed → Repaid and Borrowed →
Defaulted, encoded from the ABI.

## Deployment blocks of the external sources

Found by binary search on `eth_getCode` for the first block with code, then cross-checked against the first
log each contract emitted:

| Contract | Arbitrum One: deployed / first log | Base: deployed / first log |
|---|---|---|
| SpendPermissionManager | 283144909 / 392611911 | 23499060 / 23622712 |
| DelegationManager | 320575464 / 320575464 | 28207787 / 28207787 |
| ERC-8004 ReputationRegistry | 428895450 / 428895450 | 41663784 / 41663784 |

Base's reader start block is 23499060, the earliest of these.
