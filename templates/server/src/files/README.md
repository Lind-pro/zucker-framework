# Private files in the Server template

`FilesService` keeps application ownership and metadata in PostgreSQL and delegates verified private
object operations to the existing `PrivateFileAssetService`. The bounded HTTP attachment limit is
10 MiB; `FILES_MAX_BYTES` can lower it. Upload/import/read use bounded buffers. This template does
not claim constant-memory large-file streaming or create public bucket permissions.

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
