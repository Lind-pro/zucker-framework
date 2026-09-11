# Common

## HTTP error policy

`HttpExceptionFilter` accepts optional `HttpExceptionFilterOptions`. `formatResponse(normalized, context)` customizes the response envelope after Framework status/message/retry-header normalization. Context includes the original exception, request and classification (`http`, `business`, `validation`, `unknown`). `onServerError(context)` can report 5xx errors; a reporting exception cannot replace the HTTP response. Without options, the existing Framework envelope and behavior are unchanged. Configure product disclosure/messages as a policy object rather than wrapping Nest request/response objects.

## HTTP input and generated JSON

`TrimString` is a property transform: blank strings become undefined. It is distinct from `TrimStringPipe`. `DateTransformPipe` receives explicit parse/fromUTC functions and preserves the established body-only recursive ISO-date conversion. `QueryParamDto` is provided by the CRUD package. `extractJsonCandidate` reports the first object/array root and whether its closing delimiters were present; schema and truncation recovery policy remain with the caller.

## Subscription SSE

`streamSubscriptionAsSSE(response, { source, snapshot, transform, shouldSend, isTerminal, heartbeatMs })` streams an existing Observable-like subscription using plain `data:` events. Authorization and other asynchronous transforms are serialized; terminal delivery completes before response closure. Snapshot and replay events share the consumer's ordering policy. A synchronous source completion waits for queued delivery and initial snapshot processing.

Disconnect disposes only the subscriber, pending response writes and heartbeat; it has no producer cancellation signal. This is the entry for observing durable jobs. `streamPromiseAsSSE` remains appropriate for a request-owned operation that should abort on disconnect. Consumers retain ownership checks, terminal/version policy, error disclosure and heartbeat timing. Signing/authorization failures fail closed through the configured error observer.
