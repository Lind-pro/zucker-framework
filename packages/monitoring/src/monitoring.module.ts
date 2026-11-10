import { Module, Global, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { ErrorTracker } from './error-tracker';
import { HealthCheckService } from './health-check.service';
import { HealthController } from './health.controller';
import { InMemoryMetricsCollector } from './metrics-legacy';
import { MetricsRegistry } from './metrics/metrics-registry';
import { SystemMetricsCollector } from './metrics/system-metrics';
import { PrometheusExporter, TokenPrometheusExporter } from './metrics/prometheus-exporter';
import { AlertManagerService } from './alert/alert-manager.service';
import { AlertController } from './alert/alert.controller';
import {
  MONITORING_MODULE_OPTIONS,
  MetricsTokenGuard,
  MonitoringAccessGuard,
  type MonitoringModuleOptions,
} from './monitoring-access';

export const METRICS_COLLECTOR = Symbol('METRICS_COLLECTOR');

const PROVIDERS: Provider[] = [
  ErrorTracker,
  HealthCheckService,
  MetricsRegistry,
  SystemMetricsCollector,
  AlertManagerService,
  {
    provide: METRICS_COLLECTOR,
    useClass: InMemoryMetricsCollector,
  },
];

const EXPORTS = [
  ErrorTracker,
  HealthCheckService,
  MetricsRegistry,
  SystemMetricsCollector,
  AlertManagerService,
  METRICS_COLLECTOR,
];

/** Minimum length of a metrics scrape token. */
const MIN_METRICS_TOKEN_LENGTH = 32;

/**
 * Monitoring services plus the public `/health` endpoints.
 *
 * Importing the class directly mounts only `HealthController`. The `/metrics` and
 * `/monitoring/alerts` endpoints are opt-in through `forRoot`, and are guarded there
 * (see `MonitoringModuleOptions`).
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: PROVIDERS,
  exports: EXPORTS,
})
export class ZuckerMonitoringModule {
  static forRoot(options: MonitoringModuleOptions = {}): DynamicModule {
    // Dynamic metadata extends the static @Module metadata (HealthController and services).
    const controllers: Type[] = [];
    if (typeof options.metrics === 'object') {
      const token = options.metrics.token;
      if (typeof token !== 'string' || token.length < MIN_METRICS_TOKEN_LENGTH) {
        throw new Error(
          `ZuckerMonitoringModule: metrics.token must be at least ${MIN_METRICS_TOKEN_LENGTH} characters`,
        );
      }
      controllers.push(TokenPrometheusExporter);
    } else if (options.metrics === true) {
      controllers.push(PrometheusExporter);
    }
    if (options.alerts === true) controllers.push(AlertController);
    const sessionProtected = options.metrics === true || options.alerts === true;
    if (sessionProtected && typeof options.authorize !== 'function' && options.permissions !== 'host-guard') {
      throw new Error(
        "ZuckerMonitoringModule: metrics: true / alerts: true need `authorize` or `permissions: 'host-guard'` " +
          '(the built-in guard only checks for a signed-in user)',
      );
    }
    return {
      module: ZuckerMonitoringModule,
      global: true,
      controllers,
      providers: [
        { provide: MONITORING_MODULE_OPTIONS, useValue: options },
        MonitoringAccessGuard,
        MetricsTokenGuard,
      ],
      exports: [MONITORING_MODULE_OPTIONS],
    };
  }
}
