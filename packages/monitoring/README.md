# Monitoring

## Bounded error aggregation

Configure `ErrorTracker` with `retentionMs` for a fixed window starting at first occurrence, optional fingerprint/redaction functions, `logEntries: false` for silent aggregation, and `onNewError` for host alert policy. Expiry is applied on reads and writes; no recurring timer or lifecycle provider is needed. `errorFingerprint` hashes the error name/message/first stack location and endpoint. Default consumers retain the original category/message aggregation and unlimited retention. External reporting remains behind `ErrorReporter`; product classifications, critical keywords and tracking enablement stay in the host.

## Optional Sentry adapter and selected health probes

`SentryErrorReporter` receives explicit SDK initialization options, selected redaction fields/sections and a context mapper. It loads `@sentry/node` only when configured and initializes once. The application owns its enablement decision, DSN, sampling, tags and sensitive field list. `ERROR_REPORTER` can still use `NoopErrorReporter`.

`HealthCheckService.checkAll(names?)` reuses the existing status aggregation for readiness or diagnostics subsets. A requested but unregistered probe is DOWN. HTTP paths, status field naming and business metric queries stay with the application. `MetricsRegistry` plus `renderPrometheusMetrics` provide serialization without a second text renderer.

## Endpoint exposure (secure by default)

Importing `ZuckerMonitoringModule` directly mounts only the public `/health`, `/health/live` and `/health/ready` endpoints. `GET /metrics` and the `/monitoring/alerts` API are opt-in:

```ts
ZuckerMonitoringModule.forRoot({
  // Prometheus scrape with a dedicated secret (>= 32 chars); the route is marked public for
  // session guards and checks `Authorization: Bearer <token>` itself.
  metrics: { token: process.env.METRICS_SCRAPE_TOKEN! },
  // or `metrics: true` for a signed-in operator (see below).
  alerts: true,
  // Required with `metrics: true` / `alerts: true`: either an authorization callback ...
  authorize: (request, access) => isOperator(request, access), // access: 'metrics' | 'alerts:read' | 'alerts:write'
  // ... or the assertion that a global PermissionsGuard enforces the permission metadata:
  // permissions: 'host-guard',
});
```

`forRoot` throws when `metrics: true` or `alerts: true` is set without `authorize` or `permissions: 'host-guard'`.

What `MonitoringAccessGuard` guarantees on its own: 401 for a request without `request.user.id`, and 403 when `authorize` returns anything but `true`. It does **not** check permission codes, so without `authorize` any signed-in user would pass unless a host permissions guard runs. The host's authentication must be a global guard (`APP_GUARD`) so `request.user` is set before this guard; with controller-level authentication only, these endpoints always return 401.

The session-protected controllers carry `@Permissions()` metadata (`zucker:auth:permissions`) for the host's `PermissionsGuard`: `monitoring:query` for `GET /metrics`, `GET /monitoring/alerts` and `GET /monitoring/alerts/rules`; `monitoring:update` for creating/deleting rules and acknowledging/resolving alerts. Grant those codes to operator roles only. The acting user for acknowledge/resolve is `request.user.id`; a `userId` in the body is ignored. Rule bodies are validated and limited to `MAX_ALERT_RULES` (500); deleting a rule also deletes its `alertRules` row.

Server template: keep the bare `ZuckerMonitoringModule` import unless the product needs these endpoints; when it does, use `forRoot` as above with `permissions: 'host-guard'`, keep the global `AccountGuard` + `PermissionsGuard` ahead of the module's guard, and grant the codes by hand: `monitoring:query` and `monitoring:update` are **not** seeded by any template or permission registry, so until an operator adds them to a role, a working `PermissionsGuard` denies every caller (403).

## Bounded in-process state

`ErrorTracker` keeps at most `maxEntries` (default 1000) aggregated errors, evicting the least recently seen. `MetricsRegistry` metrics keep at most `MAX_SERIES_PER_METRIC` (1000) label sets each; additional label sets are counted in an `{overflow="true"}` series. `InMemoryMetricsCollector` keeps at most 10,000 histogram points and 10,000 counter/gauge series. `AlertManagerService` keeps at most 1000 resolved alerts.
