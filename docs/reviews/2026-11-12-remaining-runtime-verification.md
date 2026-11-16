# Remaining runtime verification for the November 12 fixes

Framework baseline: `main` at `aee88b9bcd0b4f4bd181ac3b7116897f70af63d2`, with the existing uncommitted review fixes described in `2026-11-12-review-fixes-and-ccopyright-joint-tests.md`. Consumer baseline: CCopyright `migrate/framework` at `dac278e10e9896d89e5607cf6326d13d3cb3318a`. This follow-up closes selected environment-blocked checks; it is not a release or deployment result.

## Executed checks

| Scope | Final result | Evidence and limits |
| --- | --- | --- |
| CCopyright account browser harness with the current Framework frontend source | 14 passed, 0 failed/skipped | Actual CCopyright components and installed consumer React/UI dependencies; synthetic API responses. Includes the original 12 cases and the two previously blocked cross-account mutation/refresh cases. Only test aliases point at unpublished source; formal consumer manifests and lockfile remain unchanged. |
| AI task PostgreSQL integration, gates and output-cap contracts | 20 passed, 0 failed/skipped | Actual PostgreSQL 18, transactions/locks and current task source; fake media providers and synthetic credit/storage ports. |
| AI checkpoint/recovery cases on PostgreSQL | 13 passed, 0 failed/skipped | The unchanged recovery cases were run through a test-only PostgreSQL pool/transaction bridge instead of PGlite. Covers failed settlement and storage, lost provider-result acknowledgement, cancellation, bounded output delivery and legacy-state migration. This adds driver/real-transaction evidence; it does not prove provider exactly-once behavior. |
| Template AI task HTTP launch gates | 8 passed, 0 failed/skipped | Real Nest HTTP, PostgreSQL and current Framework source; synthetic media, account mail, API keys and credits. |
| Template private-file streaming and download tickets | 11 passed, 0 failed/skipped | Real HTTP, PostgreSQL and local storage, including a 60 MiB stream, content hashes, truncated/changed data, owner isolation and ticket expiry/replay. |
| AI execution checkpoint migration | Passed | Applied the identical package/template SQL to a fresh schema on PostgreSQL 18. Four synthetic legacy rows map to `NEW`, `SUBMITTING`, `ACCEPTED`, `STORED`; old fields and row values remain unchanged, output snapshots are null, and invalid new states are rejected. The full template migrations also ran in the HTTP suites. |
| Web template current-source noEmit | Passed | Copied only template source/configuration into a fresh private test directory, generated current Next route types there, and mapped public Framework exports to their source entrypoints. No original `.next`, `next-env.d.ts`, dependency declarations or installed packages were replaced. |

The four runtime groups contain 66 executed cases in total. These counts are by executed test case, not claims of 66 distinct business requirements. Earlier passed unit suites were not repeated merely to inflate the total.

## Environment corrections and retained failures

The first template command used the repository root as its process working directory; its migration lookup failed before behavior checks. After using `templates/server` as documented, registration returned HTTP 500 because its generated Prisma Client was stale and lacked the current `userAcquisition` model. A diagnostic filter in the private test harness exposed that exact cause without changing product error handling. The template schema has changed, so its ignored generated client was refreshed with an explicit unreachable placeholder database URL. No database was connected during client generation. The 19 affected HTTP cases then passed.

The ordinary Web template noEmit command still sees stale `.next` validators, missing `fe-blocks` built declarations, and the old built `fe-auth` summary-storage declaration. The current source declaration already narrows that option to `allowIdentityChange`. The isolated current-source check passed; the ordinary built-artifact check must still be run during authorized artifact preparation. It is not recorded as a pass here.

## Preserved boundaries

- Used the existing local test PostgreSQL container on `127.0.0.1:55439`, creating only `zf_remaining_efb72cca85_test`. Suites create and remove their own random schemas. Existing developer, product and other test databases were not changed. This test database remains available.
- No paid provider, real mail, real payment, production configuration or schema operation was invoked.
- No business source edit was needed in this follow-up. Existing uncommitted Framework fixes were preserved. Only the necessary ignored Prisma client was regenerated, and this report plus private test helpers/evidence were added.
- No production application build, full release gate, immutable package packing, commit, push, publication or deployment was performed.
- These source-alias results do not replace installing a newly published immutable version into CCopyright. The consumer still declares released `1.0.21`.
- The library recovery tests cannot guarantee external exactly-once submission when the provider lacks idempotency or lookup. The existing fail-closed/explicit-unknown behavior remains the contract.
- CLI cold-cache packed-registry acceptance and full template production/browser deployment acceptance remain release-preparation work. Their earlier unit/synthetic verification is preserved, not silently promoted to a release pass.

## Evidence

Private evidence directory (contains only synthetic tests and no API/production credentials):

`/Users/lind/.codex/visualizations/2026/11/03/01a1a031-bd1e-7120-8c6b-1f04082d0cdc/framework-remaining-20261112-k9p2i_hv/`

Key files: `ccopyright-source-browser.log`, `browser-provenance.json`, `ai-postgres.json`, `ai-recovery-pg.json`, `template-persistent-final.json`, `checkpoints-postgres.log`, `web-source-typegen.log`, `web-source-typecheck.log`. Initial failing commands, the diagnostic output, and the test-only source/PG adapters are retained alongside the successful reruns.
