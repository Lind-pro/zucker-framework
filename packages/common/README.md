# Common

## Bounded IO lifecycle additions (unreleased)

`pLimit(items, concurrency, fn, { drainOnError: true })` stops scheduling after the first observed failure, waits for all already-started workers, then rejects with that first failure (including non-Error reasons). It does not cancel active operations. Existing `rejectOnError: true` without drain remains fail-fast; concurrency must be a positive integer.

`createClientDisconnectAbort(req, res, { reason: () => error })` handles an already-aborted request or destroyed response immediately, preserves normal `writableEnded` completion, and removes its event listeners on `dispose`. Compose with core's cancellation scope for timeout/ref policy.

`boundedMemoryStorage({ maxBytes, createLimitError, decodeFilename })` is structurally compatible with Multer's `StorageEngine` without a Multer runtime dependency. Default total **file bytes per request** is 200 MiB. It preserves UTF-8 multipart Chinese filenames, bounds aggregate retained file buffers, drains rejected streams, reports abort/early-close/limit/errors once, and deletes buffers on `_removeFile`. Text fields, file count, per-file limits and request/body timeouts must still be configured on the host multipart parser. `createLimitError` owns user-facing language; default is HTTP 413. `_removeFile` does not reset the request's cumulative budget. `decodeMultipartFilename` is also exported for parser integration.

## HTTP error policy

`HttpExceptionFilter` accepts optional `HttpExceptionFilterOptions`. `formatResponse(normalized, context)` customizes the response envelope after Framework status/message/retry-header normalization. Context includes the original exception, request and classification (`http`, `business`, `validation`, `unknown`). `onServerError(context)` can report 5xx errors; a reporting exception cannot replace the HTTP response. Without options, the existing Framework envelope and behavior are unchanged. Configure product disclosure/messages as a policy object rather than wrapping Nest request/response objects.

## HTTP input and generated JSON

`TrimString` is a property transform: blank strings become undefined. It is distinct from `TrimStringPipe`. `DateTransformPipe` receives explicit parse/fromUTC functions and preserves the established body-only recursive ISO-date conversion. `QueryParamDto` is provided by the CRUD package. `extractJsonCandidate` reports the first object/array root and whether its closing delimiters were present; schema and truncation recovery policy remain with the caller.

## Conservative JSON array recovery

`parseJsonWithArrayRecovery(raw, arrayKey)` is a public export added in `1.0.3`. It returns `Record<string, unknown> | null` and does not change the existing repair APIs.

```ts
import { parseJsonWithArrayRecovery } from '@zucker-framework/common';

parseJsonWithArrayRecovery(
  '{"version":1,"items":[{"id":"complete","content":"received"},{"id":"partial","content":"cut',
  'items',
);
// { version: 1, items: [{ id: 'complete', content: 'received' }] }
```

- Complete valid object roots pass through unchanged, including properties after the array. The first JSON root can be surrounded by prose, BOM or a Markdown fence.
- On EOF within a valid JSON prefix, recover only complete **object entries** of the selected **top-level** array. Preserve properties before that array; discard the incomplete entry and all properties after the last retained entry. An unclosed Markdown fence around truncated JSON is supported; malformed JSON is not repaired.
- Never synthesize a string, number, object field or array entry. Nested arrays/objects and escaped quotes/brackets/Unicode keys are handled structurally, not by matching a field-name regex.
- No complete entry, the wrong root, a missing/ambiguous target, invalid syntax or recovery nesting beyond 128 returns `null`. Syntax errors before or after a checkpoint do not become successful recovery. A complete object still needs consumer schema validation, including validating the array's element types.
- No provider retries, logging of payloads or product fallbacks are performed. Consumers choose the target key and decide whether missing trailing properties are acceptable. Use `parseRepairedJsonResponse` only when heuristic completion is appropriate for the content.

## Subscription SSE

`streamSubscriptionAsSSE(response, { source, snapshot, transform, shouldSend, isTerminal, heartbeatMs })` streams an existing Observable-like subscription using plain `data:` events. Authorization and other asynchronous transforms are serialized; terminal delivery completes before response closure. Snapshot and replay events share the consumer's ordering policy. A synchronous source completion waits for queued delivery and initial snapshot processing.

Disconnect disposes only the subscriber, pending response writes and heartbeat; it has no producer cancellation signal. This is the entry for observing durable jobs. `streamPromiseAsSSE` remains appropriate for a request-owned operation that should abort on disconnect. Consumers retain ownership checks, terminal/version policy, error disclosure and heartbeat timing. Signing/authorization failures fail closed through the configured error observer.
