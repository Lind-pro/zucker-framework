# Private files in the Server template

`FilesService` keeps application ownership and metadata in PostgreSQL and delegates verified private
object operations to the existing `PrivateFileAssetService`. The bounded HTTP attachment limit is
10 MiB; `FILES_MAX_BYTES` can lower it. Upload/import/read use bounded buffers; only server-generated
AI outputs are streamed (see below). This template does not create public bucket permissions.

## Storage connection (hot)

`FILE_MANAGER` comes from `PrivateStorageModule` (`files.module.ts`, imported once at the composition
root) over the hot `private-files` connection profile: a save applies to the next storage call, and an
upload or download that already started finishes on the client it began with (the replaced client is
closed after its last stream ends). A save that changes the provider, endpoint or bucket while file rows
exist is refused with 409 `DATA_LOCATION_CHANGE_UNACKNOWLEDGED` unless the body carries
`acknowledgeDataLocationChange: true` (the admin Connections page asks for this confirmation); the
acknowledgement is audited in the save's transaction. Existing objects are never moved: rows keep their
keys, so move the objects yourself before switching. Credential-only changes need no acknowledgement.

## Owner metadata and operations

`GET /api/files?page=1` returns `{data, total, page, pageSize: 20, limits}` for the authenticated owner.
Rows include only the existing public file metadata: identity, filename, detected MIME, size, state,
timestamps and cleanup status. Object keys, source URLs, hashes, account IDs and request keys are not
selected or returned. Limits expose only `maxFileBytes` and `urlImportEnabled`, not the host allowlist.
All private metadata responses are `private, no-store`.

The existing multipart upload, request-key lookup, inspect, read, recover and delete contracts remain.
A stable owner/Idempotency-Key binds filename and actual content identity. A changed payload conflicts;
a response loss can be recovered with `GET /files/requests/:key` and the explicit recovery operation.
Recovering an existing stored object never repeats upstream source download or business computation.

Generic deletion first locks the owner row, then the file row, matching avatar binding lock order.
If the file is the current avatar, it returns 409 `ASSET_IN_USE`. The user must remove the avatar
reference first. Otherwise deletion commits a permanent tombstone before object cleanup. Concurrent
avatar binding cannot attach that deleted object, and a committed avatar cannot be deleted by a
stale preflight check. Cleanup remains retryable through the existing recovery flow.

## AI outputs (server-generated private files)

AI task outputs are stored as the owner's ready private files by `FilesService.storeGenerated`, under
their own cap `AI_OUTPUT_MAX_BYTES` (default 209715200 = 200 MiB, at most 1 GiB; images use at most
20 MiB) instead of the 10 MiB HTTP upload limit. The output is streamed to a fresh object key while it
is hashed and capped, read back and verified, then recorded `ready` in one transaction. The request
key `ait-<task hash>-<index>` makes it idempotent per task output: an existing ready file is reused.
Any failure (cap exceeded, stream error, verification, quota) removes the object; only a process crash
between the write and the metadata insert can leave an unreferenced object.

Quota decision: AI outputs count toward the owner's file quota (bytes and files), like uploads. The
check uses the actual size under the same per-owner advisory lock as `reserve`, so concurrent uploads
and outputs cannot overshoot. A full quota fails the task with `AI_OUTPUT_QUOTA_EXCEEDED` and releases
its credit hold; owners free space by deleting files.

Files larger than `FILES_MAX_BYTES` (only server-generated ones) download through the same ticket
route as a stream: size is checked before the first byte and SHA-256 at the end (a mismatch aborts the
response). Smaller files keep the buffered verified-before-release read. The S3 provider's
`uploadStream` still collects the object in memory before its single PUT (bounded by the cap);
local storage streams to disk.

## Short-lived authenticated download tickets

`POST /api/files/:id/download-url` accepts only `{}` and requires the authenticated session, ownership
and trusted Origin. It returns `{url, expiresAt, expiresInSeconds}`, where the URL is relative:
`/api/files/:id/download?token=...`. `FILES_DOWNLOAD_TTL_SECONDS` defaults to 60 and is bounded to
1–300 seconds. The signer explicitly overrides the auth module's normal token expiry.

The default UI strips the query and calls public `POST /api/files/:id/download` with exactly
`{token: string}`, so ordinary downloads do not put the capability into a URL. The public GET endpoint
remains available for deliberate short-lived link sharing. Both exchange this bearer ticket for verified bytes. The JWT uses a dedicated
purpose and audience and binds the exact asset ID, owner, session, credential version and asset
revision. It cannot be used as an access/refresh token. Redemption validates signature and lifetime,
rechecks the active account/session/credential version, checks the file revision/deletion state,
reads and verifies size/MIME/hash through `PrivateFileAssetService`, then rechecks authorization,
expiry and the resulting revision before returning bytes. A ticket is reusable until it expires or
its bound state changes; no persistent ticket table or public storage URL is created.

Downloads use `private, no-store`, `nosniff`, `Referrer-Policy: no-referrer` and an attachment filename.
The privacy guard accepts one source only (POST body or GET query), rejects mixed/extra fields,
removes `body.token` and query text from request URL fields before logging
interceptors and completion/rejection handlers. The root logging policy disables parameter/result
capture. Tests verify successful and rejected tickets, encoded token parameter names, source signed
parameters and file body sentinels do not appear in application access/operation logs or log events.
Independent Web proxies, reverse proxies and hosting access logs must also avoid recording download
query strings; this Server test does not assert their deployment configuration.

## Explicitly allowed URL imports

`POST /api/files/import` requires the owner's session, trusted Origin and `Idempotency-Key`. The only
body fields are `{url: string, fileName?: string}`; the default filename is `import.bin`. The source
URL is used only for the download and is not added to asset metadata. Sources may include signed
query parameters, which are never echoed in provider errors or persisted by this flow.

`FILES_IMPORT_ALLOWED_HOSTS` is an operator-controlled comma-separated exact-domain allowlist. Its
empty default disables import. Wildcards, IP literals, localhost, credential URLs, non-HTTPS URLs and
non-443 ports are rejected. The public core `assertAllowedOutboundUrl` owns URL policy; arbitrary
public DNS names are not accepted. Allowed hostnames must be controlled/trusted by the operator.
Redirects are disabled and a redirect response is rejected without following it.

`FILES_IMPORT_TIMEOUT_MS` defaults to 15000 and is bounded to 1–30000. The deadline covers both the
request and streamed body reading; actual accumulated bytes and declared lengths are bounded by the
same attachment limit. Source errors become fixed messages. `FILES_IMPORT_FETCH` is injectable for
synthetic verification; production uses core `createPublicFetch({allowedProtocols: ['https:'],
allowedPorts: [443]})`: the allowlisted hostname is resolved once, every resolved address must be
public (loopback, private, link-local, CGNAT, unique-local and similar ranges are refused, as is a
mixed public/private answer set), and the request is pinned to the checked address so a second DNS
answer cannot redirect it. A refused destination returns 403 `FILE_IMPORT_SOURCE_FORBIDDEN`.

The bounded downloaded bytes go through ordinary owner/key upload. Explicit same-key retries may
read the source again, but changed content conflicts with the existing immutable asset identity.
If object writing completed before metadata failed, the pending asset can be recovered without a
source re-fetch. Import is read-only at the source and never invokes AI, payment or a new task engine.

## Verification

`test/files-extra.persistent.e2e-spec.ts` uses real PostgreSQL migrations, Nest HTTP, account/session
checks, local object storage and injected source responses. It covers owner pagination, ticket scope,
expiry/signature/audience/purpose, revocation, file revision/deletion/corruption, logging privacy,
allowlist/redirect/byte/deadline limits, object-before-metadata recovery and both avatar/delete lock
orders. Existing `files.persistent.e2e-spec.ts` and `avatars.persistent.e2e-spec.ts` remain regressions
for the original contracts. No real remote file source or S3/R2 account is called by these tests.

## Public assets (content-addressed images)

`PublicAssetsService` wraps the storage package's `PublicAssetService` for public raster images used
by CMS content and site settings. Only PNG, JPEG, WebP and GIF (single frame) are accepted, detected
from magic bytes; the client type and file name are ignored and SVG is refused (415). Every image is
decoded and re-encoded with `sharp` (orientation applied, EXIF/XMP/ICC dropped, longest edge at most
4096 px, GIF stored as PNG). The stored bytes' SHA-256 is the identity: object key
`public-assets/<sha256>.<ext>`, one `public_assets` row per hash, so identical uploads (also
concurrent ones) produce one object and one row and later uploads return the stored URL with
`deduplicated: true`. The first uploader is charged against the shared per-owner file quota
(`FILES_OWNER_MAX_BYTES`/`FILES_OWNER_MAX_FILES`, same advisory lock as private uploads).
`PUBLIC_ASSETS_MAX_BYTES` (default 5 MiB, at most 10 MiB) bounds the input. There is no delete
endpoint yet: content references assets by URL.

`POST /api/management/public-assets` (multipart, single field `file`) requires `content:manage`, a
trusted Origin and the `public-asset-upload` limiter; it returns
`{sha256, url, mimeType, size, width, height, deduplicated}`.

URLs: with `PUBLIC_ASSETS_BASE_URL` (bucket root behind a CDN or public endpoint; the bucket policy
must allow anonymous reads of `public-assets/*` only) the URL is `<base>/public-assets/<file>`.
Without it the URL is the relative application route `/api/public-assets/<sha256>.<ext>`, served by
a public, rate-limited GET that accepts only that exact name of a ready row, verifies the bytes'
hash, and answers with the stored type, `nosniff`, `Cache-Control: public, max-age=31536000,
immutable`, a strong ETag and `Content-Security-Policy: default-src 'none'; sandbox`.

## Large generated files and orphan objects

Server-generated private files (AI outputs, `FilesService.storeGenerated`) are streamed, never
buffered: with S3 the stream is uploaded in multipart parts of `FILES_S3_PART_SIZE_BYTES` (default
8 MiB, 5 MiB to 5 GiB; one part in memory at a time; a failure aborts the multipart upload). The
owner route `GET /api/files/:id/content` and ticket downloads stream files above `FILES_MAX_BYTES`
with `Content-Length` set to the stored size; the final chunk is released only after size and
SHA-256 match, and a mismatch destroys the connection, so a corrupt object always arrives truncated.

Before the first byte is uploaded, a write-ahead row in `file_object_intents` names the new object
key; the transaction that records the file row removes it. A crash in between leaves the intent. The
`file-orphans` wake source (Jobs host, at most once a minute per process, 50 intents per run) deletes
the object of any intent older than `FILES_ORPHAN_GRACE_MINUTES` (default 60) that no
`file_assets`/`public_assets` row references, then the intent. Each intent is locked with
`SKIP LOCKED` and its references re-checked in the transaction that removes it; recording a file
locks the intent first and fails if the sweeper already took it. Uploads refresh their intent every
quarter of the grace period. Public assets need no intent: their row is reserved before the upload.
Keep a bucket lifecycle rule that aborts incomplete multipart uploads as a backstop.
