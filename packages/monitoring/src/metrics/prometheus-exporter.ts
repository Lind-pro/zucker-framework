import { Controller, Get, Header, Inject, SetMetadata, UseGuards } from '@nestjs/common';
import { MetricsRegistry } from './metrics-registry';
import {
  MONITORING_ACCESS_KIND,
  MONITORING_PUBLIC_METADATA,
  MONITORING_QUERY_PERMISSION,
  MetricsTokenGuard,
  MonitoringAccessGuard,
  MonitoringPermissions,
} from '../monitoring-access';

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const pairs = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`);
  return `{${pairs.join(',')}}`;
}

function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/** Render a registry without requiring an HTTP server or Nest controller. */
export function renderPrometheusMetrics(registry: MetricsRegistry): string {
  const lines: string[] = [];

  for (const counter of registry.getCounters()) {
    lines.push(`# HELP ${counter.name} ${escapeHelp(counter.description)}`);
    lines.push(`# TYPE ${counter.name} counter`);
    for (const { labels, value } of counter.getAll()) {
      lines.push(`${counter.name}${formatLabels(labels)} ${value}`);
    }
  }

  for (const gauge of registry.getGauges()) {
    lines.push(`# HELP ${gauge.name} ${escapeHelp(gauge.description)}`);
    lines.push(`# TYPE ${gauge.name} gauge`);
    for (const { labels, value } of gauge.getAll()) {
      lines.push(`${gauge.name}${formatLabels(labels)} ${value}`);
    }
  }

  for (const histogram of registry.getHistograms()) {
    lines.push(`# HELP ${histogram.name} ${escapeHelp(histogram.description)}`);
    lines.push(`# TYPE ${histogram.name} histogram`);
    for (const { labels, count, sum, bucketCounts } of histogram.getAll()) {
      for (const [le, value] of Object.entries(bucketCounts)) {
        lines.push(`${histogram.name}_bucket${formatLabels({ ...labels, le })} ${value}`);
      }
      lines.push(`${histogram.name}_count${formatLabels(labels)} ${count}`);
      lines.push(`${histogram.name}_sum${formatLabels(labels)} ${sum}`);
    }
  }

  for (const timer of registry.getTimers()) {
    const histogram = timer.getHistogram();
    lines.push(`# HELP ${timer.name} ${escapeHelp(timer.description)}`);
    lines.push(`# TYPE ${timer.name} histogram`);
    for (const { labels, count, sum, bucketCounts } of histogram.getAll()) {
      for (const [le, value] of Object.entries(bucketCounts)) {
        lines.push(`${timer.name}_bucket${formatLabels({ ...labels, le })} ${value}`);
      }
      lines.push(`${timer.name}_count${formatLabels(labels)} ${count}`);
      lines.push(`${timer.name}_sum${formatLabels(labels)} ${sum}`);
    }
  }

  for (const summary of registry.getSummaries()) {
    lines.push(`# HELP ${summary.name} ${escapeHelp(summary.description)}`);
    lines.push(`# TYPE ${summary.name} summary`);
    for (const { labels, count, sum, quantileValues } of summary.getAll()) {
      for (const [quantile, value] of Object.entries(quantileValues)) {
        lines.push(`${summary.name}${formatLabels({ ...labels, quantile })} ${value}`);
      }
      lines.push(`${summary.name}_count${formatLabels(labels)} ${count}`);
      lines.push(`${summary.name}_sum${formatLabels(labels)} ${sum}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Prometheus 格式指标导出端点（会话认证）。
 *
 * Mounted by `ZuckerMonitoringModule.forRoot({ metrics: true })`. Requires an authenticated
 * `request.user` (fails closed without a host auth guard) and carries `monitoring:query`
 * permission metadata for the host's PermissionsGuard.
 */
@Controller('metrics')
@UseGuards(MonitoringAccessGuard)
@MonitoringPermissions(MONITORING_QUERY_PERMISSION)
@SetMetadata(MONITORING_ACCESS_KIND, 'metrics')
export class PrometheusExporter {
  constructor(@Inject(MetricsRegistry) private readonly registry: MetricsRegistry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    return renderPrometheusMetrics(this.registry);
  }
}

/**
 * Prometheus 导出端点（scrape token）。
 *
 * Mounted by `ZuckerMonitoringModule.forRoot({ metrics: { token } })`. Marked public for the
 * host's session guards and protected by `Authorization: Bearer <token>` instead.
 */
@Controller('metrics')
@SetMetadata(MONITORING_PUBLIC_METADATA, true)
@UseGuards(MetricsTokenGuard)
export class TokenPrometheusExporter {
  constructor(@Inject(MetricsRegistry) private readonly registry: MetricsRegistry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    return renderPrometheusMetrics(this.registry);
  }
}
