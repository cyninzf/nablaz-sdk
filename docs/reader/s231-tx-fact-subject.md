# S231: a per-fact `subject` on tx reads (recon and one proposal)

Proposal only; the CTO rules, and the build is its own later vehicle. Read from `origin/main` 79b09b4 on 2026-11-25.
Paths are `packages/reader/` unless stated.

**Finding (web side).** `GET /read/:chainId/tx/:txHash` serves facts from the GET /read builders (`src/api/tx.ts:96-103`),
and the `Fact` type has no subject (`src/read.ts:37-44`). On GET /read the URL is the subject, so nothing was lost.
On the tx door, nothing says whose page a fact belongs on.

## Where the subject is known, kind by kind

"Subject" here means: an address in the fact's own cited row, in a column that GET /read selects that table on
(`src/api/index.ts:338-357`). Following the link then lands on a page that serves the same citation. Every column
below is `notNull` in `ponder.schema.ts`.

| Fact (source) | GET /read selects on | Proposed subject | In the served terms today? | Verdict |
| --- | --- | --- | --- | --- |
| `nablaz:record` | `subject` (`index.ts:338`) | `subject` | **no**: only in `reproduce` (`read.ts:193`) | unambiguous; /feed already uses it (`api/feed.ts:131`) |
| `nablaz:vault_payment` | `account` (`index.ts:339`) | `account` | **no** (`read.ts:205`) | unambiguous; /feed already uses it (`api/feed.ts:146`) |
| `coinbase:spend_permission`, `metamask:delegation` | `subject` or `grantee` (`index.ts:343`) | `subject` (the grantor: SPM `account`, DM `delegator`; `src/external.ts:67,96,167`) | yes, `terms.subject` (`read.ts:219`) | two parties; /feed rules `subject` (`api/feed.ts:138`) |
| `*_payment` (SPM, DM) | `payer` or `payee` (`index.ts:347`) | `payer` | yes, `terms.payer` (`read.ts:234`) | two parties; /feed rules `payer` (`api/feed.ts:162`) |
| `metamask:redemption` | `rootDelegator`, `delegator` or `delegate` (`index.ts:354`) | `delegator` (this hop's grantor; the same column a delegation's `subject` comes from, `external.ts:149,167`) | yes, `terms.delegator` (`read.ts:263`) | **ambiguous**: three parties, no /feed precedent, and `rootDelegator` differs from `delegator` on multi-hop chains. Needs a ruling |
| `agent_credit_lines` | `party` (`index.ts:357`) | `party` | yes, `terms.party` (`read.ts:278`) | unambiguous |
| `erc8004:feedback_grounding` | not served on the tx door (`api/tx.ts:41-42`) | (the page's address) | n/a | out of scope: subject-page only |

No fact the tx door serves today lacks a subject. The two the site cannot link are records and vault payments,
and their subject is a non-null column of the cited row.

## Build-id boundary

Ponder's build id hashes every `src/**/*.{js,mjs,ts,mts}` **outside `src/api/**`**, plus `ponder.schema.ts` and the
evaluated `ponder.config.ts` (`scripts/bid.mjs:3-8`). It hashes raw text, so a comment or type-only edit counts too.

- **Preserving** (no reindex; deployable like any API change): attach `subject` in `src/api/tx.ts` only.
  - Every builder maps one row to one fact (`read.ts:184,200,215,227,258,274`), so the door can pair each row with
    its fact before the sort at `tx.ts:103`.
  - Declare the widened type there, e.g. `type TxFact = Fact & { subject: string; subjectField: string }`.
  - `withUtc` spreads the fact (`api/utc.ts:67`), so the key survives serving.
  - Tests: `test/unit/tx.test.ts` (not hashed).
- **Moving** (full-reindex class): any edit to `src/read.ts`, including widening `Fact` there or adding `subject`
  inside a builder. `src/read.ts` sits outside `src/api/` and is hashed, even though only the API imports it.
- **No schema or indexing change is needed**: every subject column above is already indexed and selected.

## Contracts

- **/feed:** untouched. Its items already carry `subject` from the same columns (`api/feed.ts:112-122`). The
  proposal reuses /feed's choices, so the two doors agree.
- **MCP front:** no change. The front relays the tx door's body (`packages/mcp/src/http.ts:43`). The MCP read tool
  takes an address and never serves tx facts.

## Proposal (one)

Add two fields to every fact on the tx door, always present:

- `subject`: the address from the table above, lower-case (as /feed).
- `subjectField`: the name of the cited row's column it was taken from, e.g. `"payer"` or `"delegator"`.

The second field makes the link checkable against the citation instead of asserted: the subject is a field of the
cited log, and the answer says which one. A future kind with no such column serves `subject: null` with
`subjectField: null` and a `subjectReason` string. The field is never absent: an absent field cannot be told apart
from an older server, and the reader's rule is that what it cannot state is said, not omitted (R-S189-6).

Open for the ruling: redemption's subject is `delegator` (proposed) or `rootDelegator`.
