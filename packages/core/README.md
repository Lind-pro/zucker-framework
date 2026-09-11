# Core

## Template escaping

`escapeHtml(text)` escapes `&`, `<`, `>`, double quotes and single quotes for HTML text/attribute content. The template parser uses the same primitive when `escapeHtml: true`; consumers can use it directly for host-authored template components. It does not validate URL protocols or sanitize arbitrary HTML documents.

## Stored secret encryption

`SecretCipher({ masterKey })` receives a key string or lazy key getter; it never reads environment variables or supplies a fallback. New values use `v2.<salt>.<iv>.<tag>.<ciphertext>` with base64 components, a random 16-byte salt, a random 12-byte IV, scrypt-derived 256-bit keys and a 16-byte GCM authentication tag. `isSecureCiphertext` / `isLegacyCiphertext` identify envelope shapes; decryption validates parameters and integrity.

Set `legacyCbc: { salt }` only for historical `ivHex:ciphertextHex` data using an explicitly known scrypt salt. Legacy support is read-only and disabled by default. Unknown/plaintext values are rejected. Hosts own key-source, rotation and migration policy; callers should not log plaintext or ciphertext. The codec preserves valid existing encodings and does not rewrite stored rows.

## Cancellation, admission and dates

`createCancellationScope({ parent, timeoutMs, abortReason, timeoutReason })` returns a controller, signal and disposer. `waitForSignal` releases its listener on either outcome and consumes late failures. `withStreamIdleTimeout` bounds each pending chunk, invokes the configured abort callback and finalizes abandoned iterators without waiting forever. `ConcurrencyBulkhead` bounds admitted and queued calls with a configurable rejection error. `ZonedTime` receives an explicit timezone; it never selects an application timezone itself.

## Browser-safe shared mechanics

`@zucker-framework/core/privacy` exports `redactFields` without Node dependencies; `@zucker-framework/core/user-agent` exports `inspectUserAgent` using the existing UA parser. Frontend entry points import these subpaths rather than the Node-oriented root. UI labels and version display remain consumer policy. `safeHtmlLinkHref` provides runtime-template protocol filtering and HTML attribute escaping; it does not authorize outbound network access.
