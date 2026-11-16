import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryTimeSeriesManager } from './memory-timeseries';
import { AggregationType } from './timeseries-service';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Package review regressions', () => {
  it.each([undefined, 10])('R07: legitimate zero aggregation is preserved (%s)', async interval => {
    const manager = new MemoryTimeSeriesManager();
    manager.registerMetric({ metric: 'm', fields: [], tags: [] } as never);
    const service = manager.getService('m');
    await service.saveBatch([{ timestamp: 1, tags: {}, values: { v: 1 } }, { timestamp: 2, tags: {}, values: { v: -1 } }]);
    const results = await service.aggregate({ metric: 'm', from: 0, to: 10, field: 'v', aggregation: AggregationType.SUM,
      interval, columns: [{ property: 'v', aggregation: AggregationType.SUM, defaultValue: 99 }] });
    expect(results[0].value).toBe(0);
  });


  it.each([undefined, 10])('uses defaults only for missing values (interval %s)', async interval => {
    const manager = new MemoryTimeSeriesManager();
    manager.registerMetric({ metric: 'm', fields: [], tags: [] } as never);
    const service = manager.getService('m');
    await service.save({ timestamp: 1, tags: {}, values: { v: 0 } });
    for (const aggregation of [AggregationType.SUM, AggregationType.AVG, AggregationType.MIN, AggregationType.MAX, AggregationType.FIRST, AggregationType.TOP]) {
      const [result] = await service.aggregate({ metric: 'm', from: 0, to: 10, field: 'v', aggregation, interval,
        columns: [{ property: 'v', aggregation, defaultValue: 99 }, { property: 'missing', aggregation, defaultValue: 99 }] });
      expect(result.values).toEqual({ v: 0, missing: 99 });
    }
  });

});
