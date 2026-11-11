# Storage

## Durable private file assets (unreleased)

`PrivateFileAssetService<TContext>` adds persistent metadata orchestration to the existing `FileManager`, `BufferedFileManagerStore` and verified transfer APIs. Objects remain in private object storage; metadata and recovery facts belong to the consumer's database. The package does not import a product schema, provide an in-memory persistence default, generate media, or start background workers.

Construct the service with a `FileAssetRepository`, a `PrivateFileObjectStore`, a required `authorize(context, { scope, action, assetId? })` policy, a content detector and an explicit positive `maxObjectBytes`. `BufferedFileManagerStore` implements the object port, including idempotent `delete`, over existing Local/S3/WebDAV providers. Use a genuinely private bucket/namespace; a private upload ACL cannot undo a public bucket policy, and a local directory must not be exposed as static public files.

Local existence checks return false only for `ENOENT`/`ENOTDIR`; deletion directly unlinks and ignores only `ENOENT`. Permission and other filesystem failures propagate, so inaccessible local objects cannot produce a false cleanup confirmation.

The host derives `scope` from authenticated server context and decides ownership/tenant/operator policy. Supplying a scope from request data is not authorization. Rejected policy calls perform no metadata or object IO; scoped repository lookups also prevent IDs from another scope from exposing objects. Repository rows and object keys are internal integration data, not a public-file URL contract.

| Entry | Behavior |
| --- | --- |
| `upload(context, { scope, idempotencyKey, fileName, body })` | Snapshots a bounded nonempty buffer, detects MIME and hashes it; atomically reserves metadata before private object IO. Existing identical requests reuse their identity. Changed bytes, size, MIME or normalized filename under the same scoped key are rejected before object IO. Successful transfer is read back and verified before `ready` is committed. |
| `inspect(context, scope, id)` | Returns authorized metadata, including pending/deleted state; does not grant file access. |
| `read(context, scope, id)` | Requires `ready`; returns bounded bytes only after size/MIME/hash verification and a final deletion-state check. No public or signed URL is returned or persisted. |
| `recover(context, scope, id)` | For an interrupted upload, verifies an already stored object and commits readiness without writing new bytes. Missing pending content remains pending; retry `upload` with the same bytes when needed. For a tombstone, retries object cleanup. |
| `delete(context, scope, id)` | Durably records logical deletion before provider IO. Attempts deletion and verifies current absence; failures reject while preserving the tombstone for recovery. Repeating deletion also rechecks previously confirmed cleanup. |

`FileAsset.state` is `pending`, `ready` or `deleted`. **Deleted means logically inaccessible**, regardless of the independent `cleanupStatus`. `cleanupStatus: 'confirmed'` and `cleanupConfirmedAt` record an observed absence after a deletion attempt; they do not prove permanent physical deletion. The existing provider APIs cannot fence a remote upload that outlives a crashed process. A late completion cannot change deleted metadata back to ready; the live service attempts compensating cleanup, and retained tombstones allow durable workers to remove later arrivals. Never recycle or discard their idempotency/object keys merely because one existence check returned false.

### Durable repository and recovery integration

The consumer implements the exported `FileAssetRepository` port:

- `reserve(candidate)` must be atomic under a database unique constraint on `(scope, idempotencyKey)`. Return the existing immutable row on that conflict. New rows use the supplied unique ID/object key, `state: 'pending'`, `revision: 0`, `updatedAt: createdAt` and null deletion/cleanup fields. IDs and object keys must also be unique.
- `get(scope, id)` performs a scoped read and returns null only for an absent row. Database/permission/network failures reject.
- `compareAndSwap(scope, id, revision, update)` atomically applies only mutable state/timestamp/cleanup fields and increments revision, returning null on a genuine revision mismatch. It never changes immutable content or ownership. Keep tombstones and enforce their terminal logical state in the adapter. Reserve/CAS operations must return independent row snapshots.
- In the same database transaction as reservations and relevant transitions, the host records a durable outbox/task for recovery. Its worker calls `recover` with a trusted system context and explicit scope/ID, retries failures, and retains reconciliation for tombstones that may have outstanding remote writes. This package alone does not supply that worker or claim the host has installed it. No manual bucket sweep is the intended recovery path.

Uploads use service-generated, dedicated `private-assets/<id>` keys, never caller-supplied paths or a shared content key. A provider error or lost response leaves a recoverable reservation; an object-success/database-commit failure does not delete the object and pretend the request failed cleanly. Recovery verifies all bytes before accepting it. Same-request concurrent uploads may repeat identical immutable object IO, while atomic reservation and revision checks prevent conflicting content or late state resurrection. There is no cross-database/object-storage transaction or exactly-once external-write claim.

`FileLifecycleManager.evaluate` remains a policy evaluator, not an authorization or deletion mechanism. The host evaluates already scoped metadata, maps selected object keys to asset IDs, and calls the authorized asset deletion API so cleanup remains journaled. Do not bypass tombstones with direct provider deletes.

Verification uses an explicitly atomic test repository double, failure/concurrency injection, and actual temporary local objects through `BufferedFileManagerStore`; temporary files are removed. Those checks establish package state/orchestration behavior, not a consumer's PostgreSQL constraints, durable recovery worker, private bucket policy or real provider behavior. Consumer integration must verify those separate contracts before deployment.

## WebDAV connection descriptor (unreleased, 1.0.21)

| Export | Contract |
| --- | --- |
| `WEBDAV_STORAGE_CONNECTION_DESCRIPTOR` | Connection-settings profile `webdav-storage`: `WEBDAV_BASE_URL` (url), `WEBDAV_USERNAME`, `WEBDAV_PASSWORD` (secret), `WEBDAV_BASE_PATH` (default `/`). Localize it with `localizeConnectionDescriptor` and register it as a profile of `@zucker-framework/back-office/settings`. |
| `webDavOptionsFromConnection(env, { allowAnonymous? })` | Local check and parser of those values into `{ url, username?, password?, basePath }` (structurally `WebDavStorageOptions`): http(s) endpoint without embedded credentials, query or fragment; username and password set together (required unless `allowAnonymous`); absolute base path without dot segments. Makes no request; errors name the key, never the value. Use it as the profile's `validate`. |

Changing the endpoint or base path of a storage that already holds objects moves where reads go; pair the profile with the settings host's data-location save guard (`createDataLocationGuard`) so such a change needs explicit acknowledgement.

## WebDAV streaming and directory APIs (unreleased)

`WebDavStorage.uploadStream(readable, key, { contentType?, signal? })` streams through a bounded Node Transform to the WebDAV SDK without collecting the file. It counts bytes, awaits both the source pipeline and remote response, and aborts/destroys the streams on source failure, remote failure, setup failure or cancellation. Failed remote writes may leave a partial remote object: the provider does not promise atomic overwrite or delete a previous object on failure. Consumers retain recovery/commit policy.

`download(key, { signal? })` checks stat is a file and returns `{ stream: Readable, size }` using the SDK's real read stream (no buffer conversion). Abort destroys the stream. Callers must consume or destroy returned streams and handle stream errors; a resolved download call does not mean all bytes have arrived.

**Type compatibility:** `FileManager.download().stream` is now honestly typed as Node `Readable`, not an `fs.ReadStream` (WebDAV/S3 streams have no file descriptor/path). `FileManager.uploadStream` accepts `Readable`. Consumers using filesystem-specific stream properties must migrate. This is a public type-contract breaking correction; release/version it accordingly. Local and S3 streaming implementations are not changed by this WebDAV work.

`list(prefix, { deep: false, includeDirectories: true, missing: 'throw' })` requests shallow entries including directories and propagates missing-directory errors for host fallback. Defaults preserve recursive files-only enumeration and empty-on-404 behavior. `WebDavEntry` includes the original `filename`, `basename`, `lastmod`, `type`, as well as generic `key`, `size`, `lastModified`, `contentType`.

`ensureDirectory(key)` is public, recursively creates missing parents and coalesces concurrent uncancelled creation. All public keys retain base-path traversal protection. Cancellation-owned upload directory operations use their own SDK signal rather than sharing another caller's cancellation.

Credentials remain required by default. Explicit `allowAnonymous: true` permits missing credentials for hosts that deliberately allow unauthenticated WebDAV endpoints; URL remains mandatory. This opt-in does not read environment variables or change host authentication policy. Storage logs never include credentials or endpoint URLs.

The host owns URL-to-key normalization, public URL settings, tenant ownership, disk fallback/recovery paths and error disclosure. No in-memory fallback or product environment configuration is introduced.

Verification includes SDK mocks and the actual installed WebDAV SDK against a local synthetic HTTP server. Neither demonstrates real infrastructure permissions, durability or remote cancellation cleanup.
