# Private account avatar

Register `AccountAvatarModule` once at the application root with the existing `FilesModule` / shared FileManager. The base `AccountModule` stays usable without storage or image decoding. The Web account page consumes `AvatarSection` and the existing authenticated HTTP client.

`GET /authorize/avatar` returns the current owner's `{ assetId, revision }`. `POST /authorize/avatar` accepts exactly one multipart `file`; `DELETE /authorize/avatar` removes the account binding. Both mutations require an allowed Origin, a stable `Idempotency-Key` and `If-Match: "<revision>"`. Unknown fields and unconditional revisions are not accepted. The CORS policy permits `If-Match`. `GET /authorize/avatar/content?revision=<revision>` returns verified private PNG bytes only while the current binding still matches that revision.

Input is limited to 2 MiB PNG/JPEG and 16,777,216 decoded pixels. Sharp decodes locally, applies orientation, crops to at most 256 × 256 pixels and strips metadata before the existing private-file upload path. Client MIME and filename do not grant permission to store or render another format. No remote URL is accepted or fetched.

The user row is locked for binding changes. Its revision CAS and immutable `account_avatar_changes` request receipt commit together. A duplicate request must match action, asset and expected revision. Replaying an older successful request returns the current avatar plus the original `appliedRevision`, without rebinding the old asset. A slow stale upload fails instead of overwriting newer work. Object failures or a failed receipt do not claim a saved binding; retry uses the same file reservation and request key.

Replacing/removing the avatar does not delete the underlying owned file asset. Existing file ownership, tombstones and explicit file lifecycle operations remain authoritative; shared saved files are not destroyed as a side effect of a profile edit. If that asset becomes unavailable, metadata reports no displayable avatar rather than serving unverified bytes.

The browser retains selected file/request state only in memory for uncertain-response retries, shows a confirmed server image, rejects stale revisions, and revokes private blob URLs on replacement/removal. Server-rejected images require a new selection; transient storage failures retain the same request for retry. No real email, public bucket or new session store is involved.
