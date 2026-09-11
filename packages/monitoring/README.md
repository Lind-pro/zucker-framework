# Monitoring

## Bounded error aggregation

Configure `ErrorTracker` with `retentionMs` for a fixed window starting at first occurrence, optional fingerprint/redaction functions, `logEntries: false` for silent aggregation, and `onNewError` for host alert policy. Expiry is applied on reads and writes; no recurring timer or lifecycle provider is needed. `errorFingerprint` hashes the error name/message/first stack location and endpoint. Default consumers retain the original category/message aggregation and unlimited retention. External reporting remains behind `ErrorReporter`; product classifications, critical keywords and tracking enablement stay in the host.

## Optional Sentry adapter and selected health probes

`SentryErrorReporter` receives explicit SDK initialization options, selected redaction fields/sections and a context mapper. It loads `@sentry/node` only when configured and initializes once. The application owns its enablement decision, DSN, sampling, tags and sensitive field list. `ERROR_REPORTER` can still use `NoopErrorReporter`.

`HealthCheckService.checkAll(names?)` reuses the existing status aggregation for readiness or diagnostics subsets. A requested but unregistered probe is DOWN. HTTP paths, status field naming and business metric queries stay with the application. `MetricsRegistry` plus `renderPrometheusMetrics` provide serialization without a second text renderer.
