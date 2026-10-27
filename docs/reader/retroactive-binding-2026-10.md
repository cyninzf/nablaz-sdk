# Finding: retroactive binding in ERC-8004 feedback on Base

**Data:** Agentic Finance Graph's grounded-feedback fixture, Base, cutoff block 52,870,739 (CC BY 4.0, see NOTICE).
**Rule applied:** R-D2B-2 as corrected by R-S191-11, -12 and -16. The comparison is
`docs/reader/afg-agreement-2026-10-20.csv`, written by `packages/reader/test/fork/afg.fork.test.ts`.

## Mechanism

A feedback is grounded when the rater sent an ERC-20 transfer to the agentId's payment address before the
feedback. The payment address at a block is the agentWallet there, else the identity's owner there
(R-S191-16), and it is never resolved at a later block.

In 122 feedback entries, the payment and the identity happen in this order:

1. The rater transfers USDC to an address P.
2. Later, an identity is minted (ERC-8004 `register`, s3 §6.4b (9)).
3. P becomes bound to it. For 36 of the 38 identities, another address mints it and transfers it to P
   (ERC-721 `Transfer`, s3 §6.4b (11)). The transfer clears the agentWallet, so P is bound as the owner. For
   the other 2, P registers the identity itself, which sets the agentWallet to P.
4. The rater writes feedback about that identity.

At the payment block the identity did not exist: `ownerOf` reverts with `ERC721NonexistentToken`, and
`getAgentWallet` returns the zero address. Resolved at the payment block, the payment was not to the
identity, so this reader reports "not grounded: identity did not exist at the payment block". Resolved at
the feedback block, P is the owner, and the same payment appears to ground the feedback. The binding is
made after the payment it would be used to justify.

## Counts

| | |
|---|---|
| Feedback entries in the fixture | 816 |
| Grounded by this reader | 694 (85.05%): 371 bound by agentWallet, 323 by owner with no agentWallet |
| Retroactive binding (all remaining disagreements) | 122 entries, 38 identities, 3 raters, 38 payment transactions |
| Identities minted by an address other than P, then transferred to P | 36 of 38 |
| Identities registered by P itself, with the agentWallet set after the payment | 2 of 38 |
| Order payment → mint → bound to P → feedback, by block | 38 of 38 |
| Distinct minters | 3 |
| Blocks from payment to mint | median 42,771 (7 to 1,634,454) |
| Blocks from mint to bound to P (0 when P minted) | median 3 (0 to 1,716) |
| Blocks from bound to P to the first feedback | median 29 (6 to 2,261,386) |

Base produces a block about every 2 seconds, so a median of 3 blocks is about 6 seconds.

## What it shows and does not show

- It shows that a payment-before-feedback rule must fix the time at which the agent's address is
  resolved. Resolved at feedback time, any earlier transfer to an address that later receives an identity
  counts as payment to that identity.
- It does not show who controls the minter, P or the rater, and it makes no claim about the intent of
  any party. Chain data cannot show that two addresses belong to the same person.
- The counts cover AFG's grounded set only. The fixture lists no feedback that AFG reports as ungrounded.

## Reproduce

For one row of the CSV: s3 §6.4b (9) for the mint and its minter, (11) for the transfer to P, (10) for
the agentWallet history, `cast receipt <payment tx> blockNumber` for the payment block, and `cast call
--block <payment block> 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "ownerOf(uint256)(address)" <agentId>`,
which reverts with selector `0x7e273289`.
