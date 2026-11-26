# S233 first measurement: total record size and growth rate

Re-run: `node docs/measurements/s233-record-size.mjs` from the repo root. It runs in a throwaway Fly console and
fails unless exactly ONE machine remains afterward. The method is in the script header.

Method: SQL on the reader's own tables in the live deployment schema `deployment-01m89nandm6z68gdjf7nfbbb9k`
(reader release v22, build fe32cfae51, five chains).

- All figures come from one transaction opened READ ONLY at REPEATABLE READ, so they share one snapshot and
  nothing can be written. The snapshot was taken at 2026-11-26T21:53:50Z.
- Counts are exact `count(*)` per table, chain and sub-kind, read in one pass per table grouped by UTC day of
  `block_timestamp`. That is the fact's chain time, not the time it was indexed.
- Sizes are `pg_total_relation_size`: heap, indexes and toast.
- The full output was captured to `/workspaces/captures/s233/record-size.txt`, a Codespace path outside the repo.

## Totals

| | rows |
|---|---:|
| All facts, all 18 tables, five chains | **16,505,801** |
| Feed items (what GET /feed pages through) | **8,057,797** |
| Feed `payment` (vault_payments + external_payments) | 5,082,490 |
| Feed `grant` (GRANT_SET entries + external_permissions) | 2,975,306 |
| Feed `account` (ACCOUNT_OPENED entries) | 1 |

On disk, the fact tables take 29,635 MiB and the whole schema 29,641 MiB. That is about 1.9 KB per fact,
indexes included.

## Per table (all chains)

| table | rows | last 7 d | last 30 d |
|---|---:|---:|---:|
| external_payments | 5,082,489 | 145,195 | 587,626 |
| external_redemptions | 3,036,928 | 72,312 | 265,502 |
| external_permissions | 2,975,305 | 68,966 | 263,611 |
| agent_wallets | 2,366,713 | 39,569 | 178,028 |
| agent_owners | 2,356,602 | 39,527 | 177,888 |
| feedbacks | 687,751 | 4,260 | 19,431 |
| record_entries | 4 | 0 | 1 |
| implementation_history | 2 | 0 | 0 |
| accounts, grants, vaults, vault_fundings, vault_payments, counterparties, factory_accounts | 1 each | 0 | 0 |
| obligation_pairs, consent_events, credit_line_events | 0 | 0 | 0 |

## Facts per kind per chain

| table / sub-kind | 10 | 137 | 8453 | 42161 | 59144 |
|---|---:|---:|---:|---:|---:|
| external_permissions delegation_manager | 7,526 | 1,066,808 | 1,003,498 | 851,442 | 15,179 |
| external_permissions spm | 886 | – | 29,551 | 415 | – |
| external_payments delegation_manager | 4,685 | 1,893,212 | 1,596,165 | 1,263,247 | 12,846 |
| external_payments spm | 1,586 | – | 310,174 | 574 | – |
| external_redemptions root | 9,081 | 1,067,517 | 1,065,303 | 875,085 | 15,222 |
| external_redemptions child | 795 | 12 | 2,841 | 1,065 | 7 |
| feedbacks | – | – | 686,670 | 1,081 | – |
| agent_wallets | – | – | 2,364,861 | 1,852 | – |
| agent_owners | – | – | 2,354,757 | 1,845 | – |
| NablaZ record (record_entries 4, plus the 1-row tables above) | – | – | – | 14 | – |
| **feed items** | **14,683** | **2,960,020** | **2,939,388** | **2,115,681** | **28,025** |

## Growth rate

Per chain, all tables:

| chain | rows | indexed span | mean over span | last 30 d | last 7 d |
|---|---:|---|---:|---:|---:|
| 8453 Base | 9,413,820 | 2024-12-12..2026-11-26 (714 d) | 13,183/d | 26,608/d | 21,656/d |
| 137 Polygon | 4,027,549 | 2025-08-22..2026-11-26 (462 d) | 8,727/d | 11,225/d | 16,349/d |
| 42161 Arbitrum | 2,996,619 | 2025-07-02..2026-11-26 (513 d) | 5,846/d | 11,493/d | 14,319/d |
| 59144 Linea | 43,254 | 2025-12-16..2026-11-26 (345 d) | 125/d | 175/d | 246/d |
| 10 OP Mainnet | 24,559 | 2024-12-12..2026-11-26 (714 d) | 34/d | 236/d | 263/d |

**Rates now:**

| | last 30 d | last 7 d |
|---|---:|---:|
| All facts | 49,736/d | 52,833/d |
| Feed items | 28,375/d (≈ 850k per month) | 30,594/d |

At about 1.9 KB per fact, that is roughly 95 MB a day on disk, about 2.8 GB a month. The rate is not flat. Feed
items per UTC month:

| month | all tables | feed items | grant | payment |
|---|---:|---:|---:|---:|
| 2024-12 .. 2025-10 | 12,880 total | 7,794 total | | |
| 2025-11 | 51,698 | 36,960 | 14,683 | 22,277 |
| 2025-12 | 340,422 | 244,393 | 95,950 | 148,443 |
| 2026-01 | 643,020 | 455,953 | 176,987 | 278,966 |
| 2026-02 | 1,046,915 | 689,579 | 280,579 | 409,000 |
| 2026-03 | 1,208,154 | 774,103 | 309,395 | 464,708 |
| 2026-04 | 1,004,182 | 657,504 | 267,275 | 390,229 |
| 2026-05 | 1,053,476 | 709,469 | 282,585 | 426,884 |
| 2026-06 | 1,142,088 | 676,768 | 272,743 | 404,025 |
| 2026-07 | 1,004,936 | 645,941 | 255,411 | 390,530 |
| 2026-08 | 887,840 | 597,118 | 230,077 | 367,041 |
| 2026-09 | 1,468,566 | 1,053,017 | 298,459 | 754,558 |
| 2026-10 | 5,455,895 | 866,714 | 271,354 | 595,359 |
| 2026-11 (to the 26th) | 1,185,729 | 642,484 | 216,662 | 425,822 |

How to read the months:

- 2026-10 holds 4.6M non-feed rows. Base's ERC-8004 agent_wallets and agent_owners mostly arrived that month.
- 2026-09's payment spike is real chain activity by block time, not indexing.
- The feed has run at 0.6–1.05M items a month since February 2026.

## What this sizes (R-S232-8: design for the rate)

- At the measured rate, a page of 100 feed items covers about 5 minutes of chain time at the now-edge.
- A month is about 8,500 such pages, so the site cannot cursor-walk to a past month. That is why the
  window-by-position door (`GET /feed?at=…`) exists.
- Every settled window (bound an hour or more old) can be cached by its URL. The live set of uncacheable pages
  is the last hour: about 1,200–1,300 items.
- The feed's four tables are read through their `*_feed` indexes. Position access costs one backward index scan
  per table from the bound (`scripts/explain.mjs`, the `at` section), independent of the table's size.
