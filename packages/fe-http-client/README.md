# Frontend HTTP client

`HttpClient` provides configured JSON requests, authentication refresh, downloads, uploads and consumer error callbacks. Normalized HTTP failures retain `response`, `request`, `config`, transport `code` and `cause`, including binary error bodies. A login-page 401 clears stale authentication without redirecting. `fetchStream` preserves caller cancellation (no error toast or authentication clearing), and refreshed requests retain the caller signal. `createCookieRefresh` implements a credentials-bearing refresh exchange, while `BaseService` provides reusable CRUD requests. SSE primitives are `connectSse`, `parseSseEventBlock` and `readSseStream`.

`proxyHttpRequest(request, targetUrl, options)` forwards a standard Web `Request` and returns a streaming `Response`. The consumer must choose a trusted upstream URL and owns application routing, environment lookup and failure responses. No Next.js or backend-framework dependency is introduced.

The proxy removes the inbound Host header, forwards authentication headers and the request signal, preserves response status/headers/body, removes transfer encoding and sets `X-Accel-Buffering: no`. Mutation bodies are read once. Optional `retryDelaysMs` apply only to GET/HEAD transport failures, never to mutation requests or HTTP error statuses; abortion cancels a retry wait. Responses, including SSE, are not buffered. `fetcher` supports isolated tests and explicit transports.

Public proxy contract tests are in `src/proxy.spec.ts`. Existing HTTP/SSE tests remain relevant. New exports require validation and an immutable package release before published-package consumers use them.

`extractErrorMessage(error, { fallback, separator? })` prefers a nonempty server response message over a direct error message, accepts string-array messages and keeps consumer fallback text outside the library. The default array separator is `; `; applications can preserve an existing localized separator explicitly.

Binary HTTP failures decode JSON Blob/ArrayBuffer bodies up to 1 MiB for message/code/details, without replacing `response.data`. Malformed, oversized and non-object JSON bodies retain transport evidence and fall back to the status message. This is error decoding, not validation of downloaded files.

`RequestConfig._rawResponse: true` returns the full Axios response before envelope unwrapping, including arbitrary third-party JSON fields. It still processes token headers and HTTP errors. Default envelope behavior is unchanged; external API consumers must configure their own credential and redirect policy rather than reuse a product-authenticated client.

A cancelled `fetchStream` waiter rejects immediately while other callers can finish the shared refresh. Refreshed stream responses undergo the same permission/status checks, and retry transport failures do not revoke valid identity. `readSseStream` cancels the upstream reader on parser/consumer failure, preserves the original error if cancellation fails, and releases the lock. Source tests are not evidence that an older published version includes these lifecycle fixes.
