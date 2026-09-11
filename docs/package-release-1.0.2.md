# Unified 1.0.2 release and migration notes

Status: local version preparation; publication and consumer acceptance are separate stages.

All 51 public `@zucker-framework/*` npm packages are aligned to `1.0.2` at the
maintainer's request. Nine packages already published `1.0.1`, so that version
cannot be reused for this release. Private templates and the independent Python
renderer package retain their own versions.

## Compatibility

This alignment consolidates the pending feature and API migrations into one
maintainer-selected version. It includes breaking changes previously proposed as
major releases for auth and payment. Do not infer backward compatibility from the
patch number. The original feature descriptions remain in package changelogs.

### Auth

Permission import now requires an atomic native model `upsert` or an explicitly
configured `PermissionImportOptions.persist` callback that performs the operation
atomically. The old find/create fallback is removed. Adapters without native
upsert must supply that callback before using permission import.

Persistent verification codes require an authoritative attempt store and fail
closed on cache degradation. OAuth binding removal needs a per-user transaction
lock when concurrent-safe removal of the final login method is required. Configure
the new persistence services explicitly; application identity, TTL and account
policy remain in the consumer.

### Payment

`ZuckerPaymentModule` now requires `orderPersistence`. `OrderService` uses explicit
asynchronous persistence and no longer provides an in-memory order store. Update
callers of formerly synchronous reads and cancellation to await their results.

Recovery mail requires an atomic `RecoveryAttemptStore`; there is no default
in-memory counter or automatically created recovery table. Preserve pending or
unknown provider outcomes for reconciliation rather than issuing another charge.
Map persistence to the consumer's existing models and transaction clients. This
version change does not authorize a database migration or enable provider calls.

### Event and other additions

The event package adds `ReplayEventBus` and `RedisReplayEventBus`, with an explicit
`rxjs` peer. Consumers configure replay channels, terminal detection, cleanup and
Redis ownership. These progress notifications do not replace durable task state.

The release also includes the pending core cryptography/runtime utilities,
managed cache and rate limiting, AI execution and catalogs, persistent logging and
notification services, frontend utilities, and CLI audit tooling. See each
package's `1.0.2` changelog for its changes.

## Shared versions from this release onward

The public npm packages form one explicit Changesets `fixed` group. A future patch,
minor or major Changeset on any member applies the highest requested bump to the
whole group. Internal `workspace:*` dependencies pack to that shared exact version;
the CLI catalog records it for generated consumers.

Keep new public npm packages in the fixed group. Package publication still runs in
dependency order and is not atomic; do not upgrade consumers midway through a
partially completed batch.

## Consumer adoption and rollback

After the complete npm batch is published, consumers select exact `1.0.2` versions,
update their own lockfiles, and verify without local source links. Check the auth
and payment migrations and affected application behavior, not only compilation.
Current source-linked compilation is not acceptance of the eventual npm artifacts.

Rollback restores the consumer's previous source, exact package versions and
lockfile together. New consumer code may use APIs absent from 1.0.0/1.0.1, so
downgrading dependencies alone is insufficient. Never overwrite a published version.
