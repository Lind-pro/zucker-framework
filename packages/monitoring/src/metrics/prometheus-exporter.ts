import { Controller, Get, Header } from '@nestjs/common';
import { MetricsRegistry } from './metrics-registry';

/**
 * Prometheus 格式指标导出端点
 */
@Controller('metrics')
export class PrometheusExporter {
  constructor(private readonly registry: MetricsRegistry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    const lines: string[] = [];

    // Counters
    for (const counter of this.registry.getCounters()) {
      lines.push(`# HELP ${counter.name} ${this.escapeHelp(counter.description)}`);
      lines.push(`# TYPE ${counter.name} counter`);
      for (const { labels, value } of counter.getAll()) {
        lines.push(`${counter.name}${this.formatLabels(labels)} ${value}`);
      }
    }

    // Gauges
    for (const gauge of this.registry.getGauges()) {
      lines.push(`# HELP ${gauge.name} ${this.escapeHelp(gauge.description)}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      for (const { labels, value } of gauge.getAll()) {
        lines.push(`${gauge.name}${this.formatLabels(labels)} ${value}`);
      }
    }

    // Histograms
    for (const histogram of this.registry.getHistograms()) {
      lines.push(`# HELP ${histogram.name} ${this.escapeHelp(histogram.description)}`);
      lines.push(`# TYPE ${histogram.name} histogram`);
      for (const { labels, count, sum, bucketCounts } of histogram.getAll()) {
        for (const [le, cnt] of Object.entries(bucketCounts)) {
          lines.push(`${histogram.name}_bucket${this.formatLabels({ ...labels, le })} ${cnt}`);
        }
        lines.push(`${histogram.name}_count${this.formatLabels(labels)} ${count}`);
        lines.push(`${histogram.name}_sum${this.formatLabels(labels)} ${sum}`);
      }
    }

    // Timers (as histograms)
    for (const timer of this.registry.getTimers()) {
      const histogram = timer.getHistogram();
      lines.push(`# HELP ${timer.name} ${this.escapeHelp(timer.description)}`);
      lines.push(`# TYPE ${timer.name} histogram`);
      for (const { labels, count, sum, bucketCounts } of histogram.getAll()) {
        for (const [le, cnt] of Object.entries(bucketCounts)) {
          lines.push(`${timer.name}_bucket${this.formatLabels({ ...labels, le })} ${cnt}`);
        }
        lines.push(`${timer.name}_count${this.formatLabels(labels)} ${count}`);
        lines.push(`${timer.name}_sum${this.formatLabels(labels)} ${sum}`);
      }
    }

    // Summaries
    for (const summary of this.registry.getSummaries()) {
      lines.push(`# HELP ${summary.name} ${this.escapeHelp(summary.description)}`);
      lines.push(`# TYPE ${summary.name} summary`);
      for (const { labels, count, sum, quantileValues } of summary.getAll()) {
        for (const [quantile, value] of Object.entries(quantileValues)) {
          lines.push(`${summary.name}${this.formatLabels({ ...labels, quantile })} ${value}`);
        }
        lines.push(`${summary.name}_count${this.formatLabels(labels)} ${count}`);
        lines.push(`${summary.name}_sum${this.formatLabels(labels)} ${sum}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  private formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const pairs = entries.map(([k, v]) => `${k}="${this.escapeLabelValue(v)}"`);
    return `{${pairs.join(',')}}`;
  }

  private escapeHelp(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  }

  private escapeLabelValue(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }
}
