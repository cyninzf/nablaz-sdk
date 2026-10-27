# AFG fixture (adapted)

`erc8004-base-grounded-feedback-2026-10-20.derived.csv` is adapted from
`fixtures/erc8004-base-grounded-feedback-2026-10-20.csv` in
[AgenticFinanceGraph/agentic-finance-graph-spec](https://github.com/AgenticFinanceGraph/agentic-finance-graph-spec)
at commit `d6458fe4ea0efe187378db6a71e37bebb1462a3a`
(<https://github.com/AgenticFinanceGraph/agentic-finance-graph-spec/blob/d6458fe4ea0efe187378db6a71e37bebb1462a3a/fixtures/erc8004-base-grounded-feedback-2026-10-20.csv>,
sha256 of the original file `27e83c346fc244ba65f4f5145af915433a3ad432270c2caafed4527d92bdbc40`).

Source: Agentic Finance Graph, <https://agenticfinancegraph.com>. Cite as: Agentic Finance Graph, *Accounting
specification for machine money*, v0.9 (2026). Licence: CC BY 4.0
(<https://creativecommons.org/licenses/by/4.0/>). The repository's licence line reads "CC BY 4.0", and the
fixture's notes read "Licence CC BY 4.0".

## Changes

- Kept columns: `feedback_id`, `agent_id`, `rater`, `feedback_block`, `feedback_tx`, `payment_tx`, `payee`,
  `asset`, `rail`. All 816 rows are kept, in the original order.
- Removed columns: `value`, `value_decimals`, `tag1`, `tag2`, `feedback_uri`, `file_uri` (this reader never
  outputs a feedback's value, decimals, tags or URIs, R-D2B-2), and `feedback_at`, `amount_usd`, `payment_at`,
  `payment_event_id` (not used).

## What the rows are

Every row is a feedback AFG reports as grounded: the rater sent a stablecoin to the rated agent's bound
wallet before the feedback, with the most recent such payment (`payment_tx`). AFG's notes give the cutoff
(Base block 52,870,739) and the method. The file lists grounded feedback only.

`test/fork/afg.fork.test.ts` runs this reader's grounding on each row and writes the comparison to
`docs/reader/afg-agreement-2026-10-20.csv`.
