# Framework real persistence follow-up — 2026-11-12

This continues the local fixes in `2026-11-12-review-fixes-and-ccopyright-joint-tests.md`. The tested source baseline is `main@aee88b9bcd0b4f4bd181ac3b7116897f70af63d2` plus the existing uncommitted review fixes and the changes described here. This is source verification, not verification of a newly published Framework release. The CCopyright consumer still uses its released dependencies; they were not replaced.

## Isolated targets

- Existing test PostgreSQL container: `ccopyright-sol-20261105-postgres`, loopback `127.0.0.1:55439`. A new, uniquely named database `zf_review_20261112_2dd6fc_test` was created. No existing database was reset or migrated.
- Existing test Redis container: `ccopyright-sol-20261105-redis`, loopback `127.0.0.1:56439/13`. Sequence checks used a random key prefix and deleted only their own two keys. No database flush was used.
- PostgreSQL suites each created a unique schema. A final query confirmed zero remaining `zf_%` test schemas in the new database; the empty database itself and both containers were preserved for the parent task.
- Providers, mail and billing callbacks were synthetic. No production request, paid model call, real payment or external email was made.

## Real execution results

| Scope | Final passes | Failures / skips |
| --- | ---: | --- |
| Account host on renamed PostgreSQL tables | 13 | 0 / 0 |
| Subscription host PostgreSQL contract | 10 | 0 / 0 |
| Subscription PostgreSQL integration | 8 | 0 / 0 |
| Plans-only billing PostgreSQL integration | 18 | 0 / 0 |
| Settings PostgreSQL integration | 18 | 0 / 0 |
| Account security transaction boundaries, real PostgreSQL | 6 | 0 / 0 |
| Payment history, real PostgreSQL | 9 | 0 / 0 |
| Redis atomic sequence contract, after the transport fix | 1 | 0 / 0 |
| **Unique real-persistence cases** | **83** | **0 / 0** |

The first run had 67 passes and one Redis failure. That failure is retained in `runtime-2026-11-12-2e9358/real-contracts.{json,log}`; it was not a skipped check or an expected-failure registration. The final Redis run includes the existing concurrency, TTL, corrupt-state and overflow assertions plus eight concurrent allocations near JavaScript's safe integer limit. Related cache/token tests passed as a separate group of 20 cases (including the one Redis case); they are not added again to the total above.

The account-security and payment-history suites previously used only PGlite. A test-only SQL runtime now accepts an explicit `TEST_DATABASE_URL`: it requires a loopback hostname and an `_test` database suffix, creates its own schema, uses real pooled `BEGIN`/`COMMIT`/`ROLLBACK`, then removes only that schema. Without the variable the same assertions still use PGlite. Both modes passed the same 15 cases. Two new cases verify eight simultaneous TOTP claims admit one winner and simultaneous refunds of stacked payments leave no refunded entitlement active. Existing assertions cover admin credential/session rollback and retry, post-commit events, normalization/collision behavior, refund order/replay, payment-history rollback, legacy no-history failure and active-provider-subscription precedence over pending checkout.

## Newly reproduced and fixed Redis defect

`RedisCache.advanceSequence` previously returned a Lua number as a RESP integer. At `Number.MAX_SAFE_INTEGER`, Redis returned `9007199254740991`, but the installed ioredis RESP parser decoded that integer as `9007199254740992`. The sequence was correctly written in Redis while the caller rejected its lossy reply with `RangeError`, leaving a committed allocation behind a reported failure.

A direct read-only diagnostic returned both the numeric and decimal-string forms from the same Lua evaluation: the numeric reply was rounded, while the bulk string remained exact. The fix retains the same atomic script and TTL policy but returns the already-formatted decimal string. JavaScript accepts only canonical decimal strings (or safe numeric replies from compatible clients), converts and validates the resulting safe integer. Malformed, fractional, exponent, padded and overflowing replies remain rejected.

Changed production file: `packages/cache/src/redis-cache.ts`. Regressions: `cache-sequence.spec.ts` and `cache-sequence.integration.spec.ts`. No public method signature, database schema or consumer configuration changed.

## Commands and evidence

Commands run from the Framework root used `pnpm exec vitest run --maxWorkers=1` with explicit `TEST_DATABASE_URL` and/or `TEST_REDIS_URL`. Credentials were supplied only through the test process environment and are not in this report or evidence metadata. Later commands set `pnpm_config_verify_deps_before_run=false` to avoid implicit dependency work.

- `runtime-2026-11-12-2e9358/real-contracts.json`: first six suites, original Redis failure retained.
- `runtime-2026-11-12-2e9358/sequence-fixed.json`: fixed Redis contract and related cache/token tests, 20/20.
- `runtime-2026-11-12-2e9358/pg-final.json`: final real PostgreSQL security/history assertions, 15/15.
- `runtime-2026-11-12-2e9358/embedded-final.json`: unchanged default embedded mode, 15/15.
- `runtime-2026-11-12-2e9358/source-hashes.json`: exact relevant source hashes at verification time; later parent-task edits are not covered by these runs.
- `runtime-2026-11-12-2e9358/cleanup-check.json`: no test schemas left behind.

Targeted ESLint and `git diff --check` passed. Source-aware no-emit checking passed using a test-only tsconfig mapping public workspace exports to their current sources. The ordinary package typecheck still encounters stale/missing generated declarations (`config/connections`, newly added payment-history types); its failure is retained in `back-office-types.log` and is not represented as a pass. No production build or package-artifact verification was run.

The first `pnpm exec` unexpectedly invoked pnpm's dependency verification and installed the already-declared missing `qrcode-generator@2.0.4`, including the existing `prepare` hook. No installation was explicitly requested; subsequent commands disabled that behavior. Existing manifest/lockfile edits were preserved. This does not establish a clean release installation.

## Remaining boundaries

These checks close the earlier unavailable PostgreSQL/Redis execution evidence for the named suites, not all 23 review items or a release gate. The real PostgreSQL security/history test adapter translates the Framework ORM port to `pg`; it does not itself prove Prisma generated-client behavior. CCopyright's separate real Prisma/AppModule tests and the shared-adapter patch are required consumer evidence.

The new Redis fix remains uncommitted and unpublished, as do the previously prepared review fixes. There was no push, publication, deployment, production migration or alteration of existing application contents.
