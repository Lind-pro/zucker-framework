import { describe, expect, it } from 'vitest';
import { ErrorTracker } from './error-tracker';
import { InMemoryMetricsCollector } from './metrics-legacy';
import { MAX_SERIES_PER_METRIC, MetricsRegistry } from './metrics/metrics-registry';
import { AlertManagerService } from './alert/alert-manager.service';

describe('bounded in-process monitoring state', () => {
  it('evicts the least recently seen error beyond maxEntries', () => {
    const tracker = new ErrorTracker({ maxEntries: 2, logEntries: false });
    tracker.track(new Error('a'));
    tracker.track(new Error('b'));
    tracker.track(new Error('a'));
    tracker.track(new Error('c'));
    expect(tracker.getErrors().map((e) => e.message).sort()).toEqual(['a', 'c']);
    expect(new ErrorTracker({ logEntries: false })).toBeDefined();
    expect(() => new ErrorTracker({ maxEntries: 0 })).toThrow();
  });

  it('folds label sets beyond the per-metric cap into one overflow series', () => {
    const counter = new MetricsRegistry().counter('requests');
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 50; i += 1) counter.increment({ path: `/item/${i}` });
    const all = counter.getAll();
    expect(all).toHaveLength(MAX_SERIES_PER_METRIC + 1);
    expect(counter.get({ overflow: 'true' })).toBe(50);
  });

  it('bounds legacy histogram points and keeps counters', () => {
    const collector = new InMemoryMetricsCollector();
    collector.increment('hits');
    for (let i = 0; i < 25_000; i += 1) collector.histogram('latency', i);
    collector.increment('hits');
    const metrics = collector.getMetrics();
    expect(metrics.filter((m) => m.name === 'latency').length).toBeLessThanOrEqual(11_000);
    expect(metrics.find((m) => m.name === 'hits')?.value).toBe(2);
  });

  it('evicts old resolved alerts', () => {
    const manager = new AlertManagerService();
    manager.registerRule({ id: 'r', name: 'r', metric: 'm', condition: '>', threshold: 1, duration: 0, severity: 'LOW', enabled: true });
    for (let i = 0; i < 1_100; i += 1) {
      manager.evaluate({ m: 5 });
      manager.evaluate({ m: 0 });
    }
    expect(manager.getAlerts().length).toBeLessThanOrEqual(1_000);
  });
});
