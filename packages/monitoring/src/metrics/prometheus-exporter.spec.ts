import { describe, it, expect, beforeEach } from 'vitest';
import { PrometheusExporter, renderPrometheusMetrics } from './prometheus-exporter';
import { MetricsRegistry } from './metrics-registry';

describe('PrometheusExporter', () => {
  let registry: MetricsRegistry;
  let exporter: PrometheusExporter;

  beforeEach(() => {
    registry = new MetricsRegistry();
    exporter = new PrometheusExporter(registry);
  });

  describe('counter output', () => {
    it('should output counter in Prometheus text format', () => {
      const counter = registry.counter('http_requests_total', 'Total HTTP requests');
      counter.increment({}, 42);
      const output = exporter.getMetrics();
      expect(output).toContain('# HELP http_requests_total Total HTTP requests');
      expect(output).toContain('# TYPE http_requests_total counter');
      expect(output).toContain('http_requests_total 42');
    });

    it('should output counter with labels', () => {
      const counter = registry.counter('requests', 'Requests');
      counter.increment({ method: 'GET', path: '/api' }, 10);
      const output = exporter.getMetrics();
      expect(output).toContain('method="GET"');
      expect(output).toContain('path="/api"');
      expect(output).toContain('10');
    });
  });

  describe('gauge output', () => {
    it('should output gauge in Prometheus text format', () => {
      const gauge = registry.gauge('temperature', 'Current temperature');
      gauge.set(72.5);
      const output = exporter.getMetrics();
      expect(output).toContain('# TYPE temperature gauge');
      expect(output).toContain('temperature 72.5');
    });
  });

  describe('histogram output', () => {
    it('should output histogram with buckets', () => {
      const hist = registry.histogram('response_time', 'Response time', [0.1, 0.5, 1.0]);
      hist.observe(0.05);
      hist.observe(0.3);
      hist.observe(0.8);
      const output = exporter.getMetrics();
      expect(output).toContain('# TYPE response_time histogram');
      expect(output).toContain('response_time_bucket');
      expect(output).toContain('le="0.1"');
      expect(output).toContain('le="0.5"');
      expect(output).toContain('le="+Inf"');
      expect(output).toContain('response_time_count');
      expect(output).toContain('response_time_sum');
    });
  });

  describe('timer output', () => {
    it('should output timer as histogram', () => {
      const timer = registry.timer('db_query_duration', 'DB query duration');
      timer.record(0.05);
      timer.record(0.2);
      const output = exporter.getMetrics();
      expect(output).toContain('# TYPE db_query_duration histogram');
      expect(output).toContain('db_query_duration_count');
      expect(output).toContain('db_query_duration_sum');
    });
  });

  describe('summary output', () => {
    it('should output summary with quantile values', () => {
      const summary = registry.summary('latency', 'Latency', [0.5, 0.9]);
      for (let i = 1; i <= 10; i++) {
        summary.observe(i);
      }
      const output = exporter.getMetrics();
      expect(output).toContain('# TYPE latency summary');
      expect(output).toContain('quantile="0.5"');
      expect(output).toContain('quantile="0.9"');
      expect(output).toContain('latency_count');
      expect(output).toContain('latency_sum');
    });
  });

  describe('escaping', () => {
    it('should escape backslash and newline in HELP text', () => {
      registry.counter('metric_with_special', 'Help with \\ and \n chars');
      const output = exporter.getMetrics();
      expect(output).toContain('Help with \\\\ and \\n chars');
    });

    it('should escape label values properly', () => {
      const counter = registry.counter('test_metric', 'Test');
      counter.increment({ path: '/api?q="test"' });
      const output = exporter.getMetrics();
      expect(output).toContain('\\"test\\"');
    });
  });

  describe('empty registry', () => {
    it('should return just a newline for empty registry', () => {
      const output = exporter.getMetrics();
      expect(output).toBe('\n');
    });
  });

  it('renders without constructing a Nest controller', () => {
    registry.counter('worker_tasks_total', 'Worker tasks').increment({ outcome: 'completed' });

    expect(renderPrometheusMetrics(registry)).toContain(
      'worker_tasks_total{outcome="completed"} 1',
    );
  });

  describe('multiple metric types', () => {
    it('should output all metric types together', () => {
      registry.counter('c1', 'counter').increment();
      registry.gauge('g1', 'gauge').set(1);
      registry.histogram('h1', 'hist').observe(1);
      registry.timer('t1', 'timer').record(1);
      registry.summary('s1', 'summary').observe(1);
      const output = exporter.getMetrics();
      expect(output).toContain('# TYPE c1 counter');
      expect(output).toContain('# TYPE g1 gauge');
      expect(output).toContain('# TYPE h1 histogram');
      expect(output).toContain('# TYPE t1 histogram'); // timer is histogram
      expect(output).toContain('# TYPE s1 summary');
    });
  });
});
