export { type TrackedError, ErrorTracker } from './error-tracker';

export { ERROR_REPORTER, NoopErrorReporter } from './error-reporter';
export type { ErrorContext, ErrorReporter, ErrorReporterUser } from './error-reporter';

export {
  HealthStatus,
  type HealthCheck,
  type HealthIndicator,
  HealthCheckService,
} from './health-check.service';

export {
  type MeasurementDefinition,
  type MeasurementProvider,
  type MetricPoint,
  type MetricsCollector,
  InMemoryMetricsCollector,
} from './metrics-legacy';

export {
  MetricsRegistry,
  Counter,
  Gauge,
  Histogram,
  Summary,
  Timer,
  type MetricLabels,
  Metrics,
  type MetricsOptions,
  SystemMetricsCollector,
  type SystemMetricsOptions,
  PrometheusExporter,
  renderPrometheusMetrics,
} from './metrics/index';

export { METRICS_COLLECTOR, ZuckerMonitoringModule } from './monitoring.module';

export { HealthController, HEALTH_OPTIONS } from './health.controller';
export type { HealthOptions } from './health.controller';

export { getProcessUptime } from './process-uptime';
export type { ProcessUptimeSnapshot } from './process-uptime';

export type { AlertSeverity, AlertStatus, AlertRule, AlertRecord } from './alert/alert.interfaces';
export { AlertManagerService } from './alert/alert-manager.service';
export { AlertController } from './alert/alert.controller';

export { UsageTracker } from './usage-tracker';
export type { UsageMetrics, UsageSummary } from './usage-tracker';

export { errorFingerprint, ERROR_TRACKER_OPTIONS } from './error-tracker';
export type { ErrorTrackerOptions } from './error-tracker';

export {
  SentryErrorReporter,
  type SentryErrorReporterOptions,
  type SentrySdkPort,
  type SentryScopePort,
  type SentryScopeContext,
  type SentryEvent,
} from './sentry-error-reporter';
