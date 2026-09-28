# Frontend storage

`LocalStore` provides the shared browser storage and authentication-key contract, including best-effort handling of unavailable storage.

`setCookie(name, value, options?)`, `getCookie(name)` and `removeCookie(name, options?)` manage browser-readable cookies with SSR-safe no-op writes/null reads. Values are percent-encoded; malformed legacy encoding is returned unchanged. Names and attributes are validated before writing. `CookieOptions` supports `path`, `domain`, `expires`, `maxAge` (seconds), `sameSite` and `secure`; no authentication key, lifetime, domain or SameSite policy is hard-coded. Deletion must supply the same path/domain. HttpOnly cookies must be issued by the server, never by this API. New exports require a released artifact before production consumers switch.

`downloadBlob(blob, fileName, { revokeDelayMs? }?)` triggers a caller-requested browser download. It owns the temporary anchor and object URL, cleaning both after the click, including click failures. URL cleanup is immediate by default; a caller with an existing delayed-revocation requirement can provide that delay. Applications retain the filename, MIME type and when to download. This helper does not perform HTTP requests and throws outside a browser.
