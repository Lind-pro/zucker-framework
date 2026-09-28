# Logging

Configure `ZuckerLoggingModule` once at the application composition root. Existing event-only consumers can continue using `forRoot()`.

```ts
ZuckerLoggingModule.forRoot({
  persistence: { accessModel: 'accessLogs', operationModel: 'operationLogs' },
  pii: { sensitiveFields: ['privateDocument'] },
  retainClientIp: true,
  correlationId: false,
});
```

Persistent logging uses the host's configured `DATABASE_ADAPTER` from `@zucker-framework/core` / `@zucker-framework/crud`; it does not create a database pool or an in-memory copy. Access records use `requestTime`, operation records use `createdAt`. The public `AccessLogData`, `LogOperationData`, `StoredAccessLog` and `StoredOperationLog` types describe the fields. Statistics require the adapter's database `aggregate` and `groupBy` operations.

`AccessLogService` and `OperationLogService` provide writes, database pagination, lookup, module statistics, deletion, retention, CSV export and write metrics. The access service can merge both record kinds into an IP timeline. CSV export escapes quoted/multiline fields and neutralizes spreadsheet formulas. Queries and management failures propagate; telemetry writes are best effort and redact error diagnostics. Required transactional audit records should use the application's transaction and the audit-store contract.

The shared HTTP interceptor persists both record kinds when persistence is enabled. It retains the application's original response/error if a log writer fails, and preserves structured HTTP error messages. `retainClientIp` is an explicit host privacy decision for authorized audit queries and is off by default. Product-specific sensitive fields belong in the host's `pii` configuration. Set `correlationId: false` only when the host already establishes the same shared correlation context.

## Read query boundaries

Persistent services reject invalid/non-finite dates, reversed date ranges, invalid operation status, non-positive/fractional/unsafe pagination and overflowing offsets before calling storage. Defaults remain page 1 / size 20; valid page sizes retain the 100-row cap. CSV `limit` defaults to 10000 and must be a positive integer no larger than 10000. Invalid input raises `RangeError`; HTTP consumers should validate their public DTO aliases and map errors to their own response contract. These source hardening changes need a new formal release; existing consumers can apply DTO boundaries without importing unpublished APIs.

## System logs and operational metrics

`ApplicationLogger` implements Nest logging with independent per-injection contexts, redacted metadata and routine startup output at debug level. Register a single `WinstonLogSink` provider and transient `ApplicationLogger` providers that share it. The sink owns console/optional rotating-file destinations, an optional `DatabaseLogTransport`, and shutdown draining. Supply log level, file directory/retention and the existing database adapter explicitly. The database transport is best effort; it awaits each write before completing the stream callback and reports its own failures directly to redacted stderr to avoid recursive logging.

`OperationalMetricsService` provides slow requests, active-user operation counts, login counts/methods/failed IPs/geography, operation health/errors, PostgreSQL response-time percentiles, hourly traffic and security aggregates. Configure the access/operation models, validated access/login table names, a parameterized query callback using the existing connection, sensitive module names and detection thresholds. The host owns user enrichment, product task health, payment statistics and business thresholds. No extra pool, timer or scheduler is created.

## HTTP failure capture

Enable `rejectedRequests: { skipPaths, skipPrefixes }` in the single `ZuckerLoggingModule.forRoot()` registration to persist 4xx/5xx responses that may never reach a decorated controller. Persistence must be configured; client-IP capture follows `retainClientIp`. The shared middleware creates no pool or scheduler. `HttpErrorLoggerInterceptor` accepts `ApplicationLogger`, normalizes the request ID, and writes client rejections at warn and server failures at error with a stack. Its HTTP context is passed per entry and does not mutate the caller's logger context.

`correlationId` can be `{ headerName, requestProperty }`, allowing hosts to preserve headers such as `X-Request-Id` and their request property while using the same safe normalization and AsyncLocalStorage. Correlation middleware precedes rejected-request capture. `HttpErrorLoggerInterceptor` also supports `slowRequestMs` and an `onServerError` observer receiving redacted request context; observer failures do not replace the original error. Set `logServerErrors: false` when the exception filter already owns server stack logs.

## Consumer metadata records

`MetadataLogService<T>(database, { modelName, serialize })` reuses persistent log writes and retention with an explicit metadata projection. The projection is required so arbitrary input/prompt bodies are not implicitly stored. Schedules, retention durations, prices and business correlation fields remain consumer policy.
