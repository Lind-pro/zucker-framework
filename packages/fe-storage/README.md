# Frontend storage

`LocalStore` provides the shared browser storage and authentication-key contract, including best-effort handling of unavailable storage.

`downloadBlob(blob, fileName, { revokeDelayMs? }?)` triggers a caller-requested browser download. It owns the temporary anchor and object URL, cleaning both after the click, including click failures. URL cleanup is immediate by default; a caller with an existing delayed-revocation requirement can provide that delay. Applications retain the filename, MIME type and when to download. This helper does not perform HTTP requests and throws outside a browser.
