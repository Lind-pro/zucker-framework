# Transactional administrator policy hooks — consumer joint verification

This local follow-up addresses the CCopyright HTTP check/write race reproduced during Phase 2 acceptance. Framework owns two neutral transaction hooks; CCopyright retains its protected role name and last-enabled-holder policy. No package version, consumer dependency, production schema or deployment changed.

## Source changes

The parent task added `AdminUserHooks.userChanging(change, tx)` and `userRolesChanging(change, tx)` to Framework admin. The controller calls them after acquiring the target user row lock, before its mutation. `userRolesChanging` receives validated role IDs and optional validated expiry data. Policy failures propagate through the same transaction; consumers must use `tx` and avoid external effects.

CCopyright now composes `CopyrightAdminUserHooks` with the canonical `AccountSessionAdminHooks`, preserving transactional credential/session behavior in the candidate Framework. The product hook serializes reductions of the `superadmin` holders with a stable role-row lock, then counts enabled existing accounts. Role replacements that grant or retain the protected role also take that lock before ordinary requested-role locks; unrelated ordinary replacements avoid it. This prevents grant(normal → protected) and revoke(protected → normal) from deadlocking.

CCopyright currently keeps role-assignment expiry disabled. The generic Framework expiry payload is covered in the package test; the product hook does not claim support for a future enabled-expiry policy.

The installed consumer dependency remains **1.0.21**, which does not call these new hooks. Its existing outer controller checks remain temporarily for that release. The concurrent last-holder case remains red with the published version and is not claimed fixed in the deployed application. Adopting the immutable candidate release and removing the superseded outer checks are still required to complete integration.

## Verification

| Run | Result | Evidence |
| --- | --- | --- |
| Framework user-controller and new policy-hook tests | 25/25 passed | `admin-policy-hooks-final.json` |
| Real PostgreSQL account security and payment history | 17/17 passed, including two hook rollback cases | `pg-policy-hook-rollback.json` |
| CCopyright published 1.0.21, selected concurrent disable/revoke regression | 1 ordinary failure, 17 pattern exclusions | `joint-published-baseline.json` |
| CCopyright actual source plus candidate Framework public-source aliases, account safety and lock-order suites | 19/19 passed | `joint-protected-final.json` |
| Deterministic pre-fix candidate lock-order variant | 1 ordinary failure, HTTP `[500,200]` | `joint-pre-order-runtime.json` |
| Fixed candidate lock-order regression | 1/1 passed, HTTP `[200,200]` | `joint-fixed-order-final.json` |

The old published-version race produced zero enabled protected holders. The candidate rejects one of two concurrent reducing requests (`[400,200]`) and retains an enabled holder. The separate grant/revoke test deliberately holds the protected row in one transaction and the ordinary row in the competing old variant; the previous early-return policy produces the observed deadlock. The fixed hook makes both paths lock the protected row first and both operations complete.

Rollback is proved over actual PostgreSQL: a policy hook writes within the provided transaction and rejects, and the user/policy changes or role replacement do not persist. The InMemoryAdapter explicitly has no rollback; initial attempts to use it for that assertion were fixture errors and were corrected rather than reported as policy-hook regressions. The admin unit suite verifies callback ordering, validation, mutation rejection and event timing only.

The consumer joint harness uses its actual `migrate/framework` code, real Prisma and HTTP, and a new loopback database `ccopyright_fix_hook_joint_*`. It maps documented Framework public entries to the candidate sources **only for testing**. Because the two repositories have separate peer installations, the test configuration resolves Nest and its shared runtime peers to the consumer's installed instances. The first mixed-instance run failed during Reflector DI setup; it executed no useful behavior and was not counted as a product failure. Formal manifests, locks and production module resolution remain unchanged.

The pre-fix lock-order variant is a test-only subclass that restores only the old early return when target roles contain the protected role. It does not patch live source or installed packages. Its first TypeScript harness failed to load and was replaced with a plain CJS test variant; both original setup logs remain in evidence.

Consumer application typechecking and targeted ESLint passed. Framework source-aware no-emit checking and targeted ESLint passed. `joint-hook-source-hashes.json` records the source files used for the final checks. Exact files and raw logs are under [runtime-2026-11-12-2e9358](./runtime-2026-11-12-2e9358/).

## Broader ordinary and durable runtime checks

The existing `vitest run` entrypoint was inspected and run without production builds or publication. It completed with **6,577 passing cases, 125 conditional skips and zero failures** (554 passed files, 16 wholly skipped). This run preceded the final optional-expiry unit addition; the changed hook area was subsequently covered by the 25-case targeted run above, not by a claim that the entire tree was rerun.

Of those skips, the five back-office PostgreSQL suites and Redis sequence check were separately executed successfully in the persistence follow-up. Five additional task/queue cases were then run against the same dedicated test database and a unique Redis queue prefix: two PostgreSQL repository tests, one killed-worker/restart/fencing test, and two BullMQ delivery/reconnect tests all passed. They clean only their unique schemas/queues. The worker subprocess uses the existing task package output; task package source was unchanged in this review. MinIO and unrelated external integrations were not created or claimed verified. The parent task owns the separate AI-task and browser evidence.

No real email, payment, AI provider call or production mutation occurred. No commit, push or publication occurred in this subtask. Test databases and evidence are retained; unique schemas and queue keys were cleaned by their test fixtures.
