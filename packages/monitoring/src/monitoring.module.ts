import { Module, Global } from '@nestjs/common';
import { ErrorTracker } from './error-tracker';
import { HealthCheckService } from './health-check.service';
import { HealthController } from './health.controller';
import { InMemoryMetricsCollector } from './metrics-legacy';
import { MetricsRegistry } from './metrics/metrics-registry';
import { SystemMetricsCollector } from './metrics/system-metrics';
import { PrometheusExporter } from './metrics/prometheus-exporter';
import { AlertManagerService } from './alert/alert-manager.service';
import { AlertController } from './alert/alert.controller';

export const METRICS_COLLECTOR = Symbol('METRICS_COLLECTOR');

@Global()
@Module({
  controllers: [HealthController, PrometheusExporter, AlertController],
  providers: [
    ErrorTracker,
    HealthCheckService,
    MetricsRegistry,
    SystemMetricsCollector,
    AlertManagerService,
    {
      provide: METRICS_COLLECTOR,
      useClass: InMemoryMetricsCollector,
    },
  ],
  exports: [
    ErrorTracker,
    HealthCheckService,
    MetricsRegistry,
    SystemMetricsCollector,
    AlertManagerService,
    METRICS_COLLECTOR,
  ],
})
export class ZuckerMonitoringModule {}
