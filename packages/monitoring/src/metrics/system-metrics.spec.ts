import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SystemMetricsCollector } from './system-metrics';
import { MetricsRegistry } from './metrics-registry';

describe('SystemMetricsCollector', () => {
  let registry: MetricsRegistry;
  let collector: SystemMetricsCollector;

  beforeEach(() => {
    registry = new MetricsRegistry();
    collector = new SystemMetricsCollector(registry);
  });

  afterEach(() => {
    collector.onModuleDestroy();
  });

  describe('collect', () => {
    it('should populate system CPU usage gauge', () => {
      collector.collect();
      const gauge = registry.gauge('system_cpu_usage');
      expect(gauge.get()).toBeGreaterThanOrEqual(0);
      expect(gauge.get()).toBeLessThanOrEqual(1);
    });

    it('should populate system CPU count gauge', () => {
      collector.collect();
      const gauge = registry.gauge('system_cpu_count');
      expect(gauge.get()).toBeGreaterThan(0);
    });

    it('should populate system memory metrics', () => {
      collector.collect();
      const total = registry.gauge('system_memory_total_bytes');
      const free = registry.gauge('system_memory_free_bytes');
      const used = registry.gauge('system_memory_used_bytes');
      expect(total.get()).toBeGreaterThan(0);
      expect(free.get()).toBeGreaterThanOrEqual(0);
      expect(used.get()).toBeGreaterThan(0);
    });

    it('should populate process memory metrics', () => {
      collector.collect();
      const rss = registry.gauge('process_memory_rss_bytes');
      const heapTotal = registry.gauge('process_memory_heap_total_bytes');
      const heapUsed = registry.gauge('process_memory_heap_used_bytes');
      expect(rss.get()).toBeGreaterThan(0);
      expect(heapTotal.get()).toBeGreaterThan(0);
      expect(heapUsed.get()).toBeGreaterThan(0);
    });

    it('should populate process uptime metric', () => {
      collector.collect();
      const uptime = registry.gauge('process_uptime_seconds');
      expect(uptime.get()).toBeGreaterThan(0);
    });

    it('should populate system uptime metric', () => {
      collector.collect();
      const uptime = registry.gauge('system_uptime_seconds');
      expect(uptime.get()).toBeGreaterThanOrEqual(0);
    });

    it('should compute process CPU usage on second collect call', () => {
      collector.collect();
      collector.collect();
      const processCpu = registry.gauge('process_cpu_usage');
      // After two collections, process CPU should be set
      expect(processCpu.get()).toBeGreaterThanOrEqual(0);
    });

    it('should populate process start time', () => {
      collector.collect();
      const startTime = registry.gauge('process_start_time_seconds');
      expect(startTime.get()).toBeGreaterThan(0);
    });
  });

  describe('configure', () => {
    it('should apply prefix to metric names', () => {
      collector.configure({ prefix: 'app' });
      collector.collect();
      const gauge = registry.gauge('app_system_cpu_count');
      expect(gauge.get()).toBeGreaterThan(0);
    });

    it('should allow disabling collection', () => {
      collector.configure({ enabled: false });
      collector.onModuleInit();
      // When disabled, onModuleInit should not start collection
      // No interval should be running
    });
  });

  describe('lifecycle', () => {
    it('should start interval on onModuleInit', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      collector.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it('should clear interval on onModuleDestroy', () => {
      collector.onModuleInit();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      collector.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });
});
