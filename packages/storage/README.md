# Storage

## WebDAV streaming and directory APIs (unreleased)

`WebDavStorage.uploadStream(readable, key, { contentType?, signal? })` streams through a bounded Node Transform to the WebDAV SDK without collecting the file. It counts bytes, awaits both the source pipeline and remote response, and aborts/destroys the streams on source failure, remote failure, setup failure or cancellation. Failed remote writes may leave a partial remote object: the provider does not promise atomic overwrite or delete a previous object on failure. Consumers retain recovery/commit policy.

`download(key, { signal? })` checks stat is a file and returns `{ stream: Readable, size }` using the SDK's real read stream (no buffer conversion). Abort destroys the stream. Callers must consume or destroy returned streams and handle stream errors; a resolved download call does not mean all bytes have arrived.

**Type compatibility:** `FileManager.download().stream` is now honestly typed as Node `Readable`, not an `fs.ReadStream` (WebDAV/S3 streams have no file descriptor/path). `FileManager.uploadStream` accepts `Readable`. Consumers using filesystem-specific stream properties must migrate. This is a public type-contract breaking correction; release/version it accordingly. Local and S3 streaming implementations are not changed by this WebDAV work.

`list(prefix, { deep: false, includeDirectories: true, missing: 'throw' })` requests shallow entries including directories and propagates missing-directory errors for host fallback. Defaults preserve recursive files-only enumeration and empty-on-404 behavior. `WebDavEntry` includes the original `filename`, `basename`, `lastmod`, `type`, as well as generic `key`, `size`, `lastModified`, `contentType`.

`ensureDirectory(key)` is public, recursively creates missing parents and coalesces concurrent uncancelled creation. All public keys retain base-path traversal protection. Cancellation-owned upload directory operations use their own SDK signal rather than sharing another caller's cancellation.

Credentials remain required by default. Explicit `allowAnonymous: true` permits missing credentials for hosts that deliberately allow unauthenticated WebDAV endpoints; URL remains mandatory. This opt-in does not read environment variables or change host authentication policy. Storage logs never include credentials or endpoint URLs.

The host owns URL-to-key normalization, public URL settings, tenant ownership, disk fallback/recovery paths and error disclosure. No in-memory fallback or product environment configuration is introduced.

Verification includes SDK mocks and the actual installed WebDAV SDK against a local synthetic HTTP server. Neither demonstrates real infrastructure permissions, durability or remote cancellation cleanup.
