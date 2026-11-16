# Frontend HTTP client

`HttpClient` provides configured JSON requests, authentication refresh, downloads, uploads and consumer error callbacks. Normalized HTTP failures retain `response`, `request`, `config`, transport `code` and `cause`, including binary error bodies. A login-page 401 clears stale authentication without redirecting. `fetchStream` preserves caller cancellation (no error toast or authentication clearing), and refreshed requests retain the caller signal. `createCookieRefresh` implements a credentials-bearing refresh exchange, while `BaseService` provides reusable CRUD requests. SSE primitives are `connectSse`, `parseSseEventBlock` and `readSseStream`.

## Cookie refresh that survives navigation

Servers that rotate the refresh token on every accepted `POST <refresh>` deliver the new token only in that response's `Set-Cookie`; a request cut off by a page unload after rotation leaves a stale cookie and the next exchange is denied as a replay. Two exports close that window without weakening replay protection:

- `createKeepaliveCookieRefresh(url, { fetch? }): RefreshTransport` posts with `credentials: 'include'` and `keepalive: true`, honors the `AbortSignal` it receives, accepts `{ access_token }` or a `{ result: { access_token } }` envelope, and attaches `status` to every error that follows an HTTP answer (including a malformed 200). `createCookieRefresh` (axios) now also accepts a signal and attaches `status: 200` to a malformed response.
- `createRefreshExchange({ transport, markerKey, graceMs = 10000, timeoutMs = 15000, storage?, documentId?, events?, now?, sleep? })` returns `() => Promise<{ access_token }>`. Each exchange records a localStorage marker `{ id, documentId, startedAt }`; on `pagehide` during the exchange the marker is flagged `interrupted`. A later exchange retries a 401 with backoff (250 ms doubling, at most 2 s) only while an interrupted marker left by another document is younger than `graceMs`; a concurrent refresh in another live tab never causes waiting. Each attempt is aborted after `timeoutMs` and rejects with `RefreshTimeoutError` (no status); an outcome without an HTTP status keeps the marker, any HTTP answer clears it.

Also exported: `RefreshTransport`, `RefreshExchangeOptions`, `KeepaliveCookieRefreshOptions`, `RefreshTimeoutError`, `DEFAULT_REFRESH_GRACE_MS`, `DEFAULT_REFRESH_TIMEOUT_MS`, `refreshErrorStatus(error)` and `combineAbortSignals(signals)` (`AbortSignal.any` with a fallback). `@zucker-framework/fe-admin` composes these for its session; tests: `src/cookie-refresh-exchange.spec.ts`.

`proxyHttpRequest(request, targetUrl, options)` forwards a standard Web `Request` and returns a streaming `Response`. The consumer must choose a trusted upstream URL and owns application routing, environment lookup and failure responses. No Next.js or backend-framework dependency is introduced.

The proxy removes the inbound Host header, forwards authentication headers and the request signal, preserves response status/headers/body, removes transfer encoding and sets `X-Accel-Buffering: no`. Mutation bodies are read once. Optional `retryDelaysMs` apply only to GET/HEAD transport failures, never to mutation requests or HTTP error statuses; abortion cancels a retry wait. Responses, including SSE, are not buffered. `fetcher` supports isolated tests and explicit transports.

Public proxy contract tests are in `src/proxy.spec.ts`. Existing HTTP/SSE tests remain relevant. New exports require validation and an immutable package release before published-package consumers use them.

`extractErrorMessage(error, { fallback, separator? })` prefers a nonempty server response message over a direct error message, accepts string-array messages and keeps consumer fallback text outside the library. The default array separator is `; `; applications can preserve an existing localized separator explicitly.

Binary HTTP failures decode JSON Blob/ArrayBuffer bodies up to 1 MiB for message/code/details, without replacing `response.data`. Malformed, oversized and non-object JSON bodies retain transport evidence and fall back to the status message. This is error decoding, not validation of downloaded files.

`RequestConfig._rawResponse: true` returns the full Axios response before envelope unwrapping, including arbitrary third-party JSON fields. It still processes token headers and HTTP errors. Default envelope behavior is unchanged; external API consumers must configure their own credential and redirect policy rather than reuse a product-authenticated client.

A cancelled `fetchStream` waiter rejects immediately while other callers can finish the shared refresh. Refreshed stream responses undergo the same permission/status checks, and retry transport failures do not revoke valid identity. `readSseStream` cancels the upstream reader on parser/consumer failure, preserves the original error if cancellation fails, and releases the lock. Source tests are not evidence that an older published version includes these lifecycle fixes.


`HttpClientConfig.sessionKey(token)` identifies a session across access-token rotation. For example, pass
`jwtSessionKey(['sub', 'sid'])` from `@zucker-framework/fe-auth`; include a session identifier rather than
only a user id. The client binds Axios and `fetchStream` requests to their starting credentials, checks
again after the refresh lock and exchange, and cancels a stale retry with `ERR_CANCELED`. A late refresh
failure cannot clear a newer session. The callback compares identity only; it never authorizes requests.

Without `sessionKey`, an unchanged access token (or an unchanged explicit refresh token) proves continuity.
Cookie clients without a recognizable session key conservatively cancel if another request/tab rotates the
access token while they wait; configure the callback to retain cross-tab reuse. Cookie refresh never reads
or persists a JavaScript refresh token. Keep `createSessionRequestScope` / abort signals to cancel active
work promptly on sign-out and to distinguish sign-out/sign-in using the same credentials. Web and fe-admin
source consumers now pass their existing session key; published consumers need the next immutable release.
