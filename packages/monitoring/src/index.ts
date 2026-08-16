export {
  type TrackedError,
  ErrorTracker,
} from './error-tracker';

export {
  ERROR_REPORTER,
  NoopErrorReporter,
} from './error-reporter';
export type {
  ErrorContext,
  ErrorReporter,
  ErrorReporterUser,
} from './error-reporter';

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
} from './metrics/index';

export {
  METRICS_COLLECTOR,
  ZuckerMonitoringModule,
} from './monitoring.module';

export { HealthController, HEALTH_OPTIONS } from './health.controller';
export type { HealthOptions } from './health.controller';

export type {
  AlertSeverity,
  AlertStatus,
  AlertRule,
  AlertRecord,
} from './alert/alert.interfaces';
export { AlertManagerService } from './alert/alert-manager.service';
export { AlertController } from './alert/alert.controller';

export { UsageTracker } from './usage-tracker';
export type { UsageMetrics, UsageSummary } from './usage-tracker';
