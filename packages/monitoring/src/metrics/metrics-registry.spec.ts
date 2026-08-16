import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetricsRegistry, Counter, Histogram, Summary } from './metrics-registry';

describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Counter', () => {
    it('should create and retrieve a counter', () => {
      const counter = registry.counter('http_requests_total', 'Total HTTP requests');
      expect(counter).toBeInstanceOf(Counter);
      expect(counter.name).toBe('http_requests_total');
    });

    it('should return same counter for same name', () => {
      const c1 = registry.counter('req');
      const c2 = registry.counter('req');
      expect(c1).toBe(c2);
    });

    it('should increment counter value', () => {
      const counter = registry.counter('hits');
      counter.increment();
      counter.increment({}, 5);
      expect(counter.get()).toBe(6);
    });

    it('should support labels', () => {
      const counter = registry.counter('reqs');
      counter.increment({ method: 'GET' }, 3);
      counter.increment({ method: 'POST' }, 2);
      expect(counter.get({ method: 'GET' })).toBe(3);
      expect(counter.get({ method: 'POST' })).toBe(2);
    });

    it('should return all label combinations via getAll', () => {
      const counter = registry.counter('reqs');
      counter.increment({ method: 'GET' });
      counter.increment({ method: 'POST' });
      const all = counter.getAll();
      expect(all).toHaveLength(2);
    });

    it('should return 0 for non-existent labels', () => {
      const counter = registry.counter('reqs');
      expect(counter.get({ method: 'DELETE' })).toBe(0);
    });
  });

  describe('Gauge', () => {
    it('should set and get gauge value', () => {
      const gauge = registry.gauge('temperature', 'CPU temp');
      gauge.set(72.5);
      expect(gauge.get()).toBe(72.5);
    });

    it('should increment and decrement', () => {
      const gauge = registry.gauge('connections');
      gauge.increment();
      gauge.increment({}, 2);
      expect(gauge.get()).toBe(3);
      gauge.decrement({}, 1);
      expect(gauge.get()).toBe(2);
    });

    it('should support labels', () => {
      const gauge = registry.gauge('queue_size');
      gauge.set(10, { queue: 'email' });
      gauge.set(5, { queue: 'sms' });
      expect(gauge.get({ queue: 'email' })).toBe(10);
      expect(gauge.get({ queue: 'sms' })).toBe(5);
    });
  });

  describe('Histogram', () => {
    it('should record observations', () => {
      const hist = registry.histogram('response_time', 'Response time');
      hist.observe(0.1);
      hist.observe(0.5);
      hist.observe(1.0);
      expect(hist.getCount()).toBe(3);
      expect(hist.getSum()).toBeCloseTo(1.6);
    });

    it('should compute percentiles', () => {
      const hist = registry.histogram('latency');
      for (let i = 1; i <= 100; i++) {
        hist.observe(i);
      }
      expect(hist.getPercentile(50)).toBe(50);
      expect(hist.getPercentile(99)).toBe(99);
    });

    it('should return 0 for empty histogram percentile', () => {
      const hist = registry.histogram('empty');
      expect(hist.getPercentile(50)).toBe(0);
    });

    it('should compute bucket counts', () => {
      const hist = registry.histogram('req_duration', '', [0.1, 0.5, 1.0]);
      hist.observe(0.05);
      hist.observe(0.3);
      hist.observe(0.8);
      hist.observe(2.0);
      const all = hist.getAll();
      expect(all).toHaveLength(1);
      const entry = all[0];
      expect(entry.bucketCounts['0.1']).toBe(1);
      expect(entry.bucketCounts['0.5']).toBe(2);
      expect(entry.bucketCounts['1']).toBe(3);
      expect(entry.bucketCounts['+Inf']).toBe(4);
    });

    it('should support labels', () => {
      const hist = registry.histogram('duration');
      hist.observe(1, { endpoint: '/api' });
      hist.observe(2, { endpoint: '/web' });
      expect(hist.getCount({ endpoint: '/api' })).toBe(1);
      expect(hist.getCount({ endpoint: '/web' })).toBe(1);
    });

    it('keeps exact aggregates while bounding percentile samples', () => {
      const hist = new Histogram('bounded', 'Bounded histogram', [5, 10], 3);
      for (const value of [1, 2, 3, 4, 20]) hist.observe(value);

      expect(hist.getCount()).toBe(5);
      expect(hist.getSum()).toBe(30);
      expect(hist.getPercentile(50)).toBe(4);
      expect(hist.getAll()[0]).toMatchObject({
        count: 5,
        sum: 30,
        bucketCounts: { '5': 4, '10': 4, '+Inf': 5 },
      });
    });
  });

  describe('Timer', () => {
    it('should record duration in seconds', () => {
      const timer = registry.timer('op_duration', 'Operation duration');
      timer.record(0.5);
      timer.record(1.5);
      const hist = timer.getHistogram();
      expect(hist.getCount()).toBe(2);
      expect(hist.getSum()).toBeCloseTo(2.0);
    });

    it('should provide startTimer that measures elapsed time', () => {
      const timer = registry.timer('task');
      const stop = timer.startTimer();
      // Just ensure it returns a number > 0
      const duration = stop();
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(timer.getHistogram().getCount()).toBe(1);
    });
  });

  describe('Summary', () => {
    it('should observe values and compute quantiles', () => {
      const summary = registry.summary('request_duration', 'Duration', [0.5, 0.9, 0.99]);
      for (let i = 1; i <= 100; i++) {
        summary.observe(i);
      }
      expect(summary.getCount()).toBe(100);
      expect(summary.getQuantile(0.5)).toBe(50);
      expect(summary.getQuantile(0.99)).toBe(99);
    });

    it('should return 0 for empty summary quantile', () => {
      const summary = registry.summary('empty_sum');
      expect(summary.getQuantile(0.5)).toBe(0);
    });

    it('expires quantile samples without losing cumulative count and sum', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const summary = new Summary('windowed', 'Windowed summary', [0.5], 1_000, 3);
      summary.observe(10);
      summary.observe(20);
      vi.advanceTimersByTime(1_001);

      expect(summary.getQuantile(0.5)).toBe(0);
      expect(summary.getCount()).toBe(2);
      expect(summary.getSum()).toBe(30);
      expect(summary.getAll()[0]).toMatchObject({
        count: 2,
        sum: 30,
        quantileValues: { '0.5': 0 },
      });
    });

    it('bounds the active quantile sample window', () => {
      const summary = new Summary('bounded-summary', 'Bounded summary', [0.5], 60_000, 3);
      for (const value of [1, 2, 3, 4, 5]) summary.observe(value);

      expect(summary.getQuantile(0.5)).toBe(4);
      expect(summary.getCount()).toBe(5);
      expect(summary.getSum()).toBe(15);
    });
  });

  describe('registry operations', () => {
    it('should list all counters', () => {
      registry.counter('a');
      registry.counter('b');
      expect(registry.getCounters()).toHaveLength(2);
    });

    it('should clear all metrics', () => {
      registry.counter('a');
      registry.gauge('b');
      registry.histogram('c');
      registry.timer('d');
      registry.summary('e');
      registry.clear();
      expect(registry.getCounters()).toHaveLength(0);
      expect(registry.getGauges()).toHaveLength(0);
      expect(registry.getHistograms()).toHaveLength(0);
      expect(registry.getTimers()).toHaveLength(0);
      expect(registry.getSummaries()).toHaveLength(0);
    });
  });
});
