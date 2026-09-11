# Frontend HTTP client

`HttpClient` provides configured JSON requests, authentication refresh, downloads, uploads and consumer error callbacks. `createCookieRefresh` implements a credentials-bearing refresh exchange, while `BaseService` provides reusable CRUD requests. SSE primitives are `connectSse`, `parseSseEventBlock` and `readSseStream`.

`proxyHttpRequest(request, targetUrl, options)` forwards a standard Web `Request` and returns a streaming `Response`. The consumer must choose a trusted upstream URL and owns application routing, environment lookup and failure responses. No Next.js or backend-framework dependency is introduced.

The proxy removes the inbound Host header, forwards authentication headers and the request signal, preserves response status/headers/body, removes transfer encoding and sets `X-Accel-Buffering: no`. Mutation bodies are read once. Optional `retryDelaysMs` apply only to GET/HEAD transport failures, never to mutation requests or HTTP error statuses; abortion cancels a retry wait. Responses, including SSE, are not buffered. `fetcher` supports isolated tests and explicit transports.

Public proxy contract tests are in `src/proxy.spec.ts`. Existing HTTP/SSE tests remain relevant. New exports require validation and an immutable package release before published-package consumers use them.

`extractErrorMessage(error, { fallback, separator? })` prefers a nonempty server response message over a direct error message, accepts string-array messages and keeps consumer fallback text outside the library. The default array separator is `; `; applications can preserve an existing localized separator explicitly.
