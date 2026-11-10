import { describe, expect, it } from 'vitest';
import { MemoryTimeSeriesManager } from './memory-timeseries';
import { AggregationType } from './timeseries-service';

function setup() {
  const manager = new MemoryTimeSeriesManager();
  manager.registerMetric({ metric: 'm', fields: [], tags: ['a', 'b'] } as never);
  return manager.getService('m');
}

describe('MemoryTimeSeriesService aggregation (review L17)', () => {
  it('computes MIN/MAX over more values than the argument limit', async () => {
    const service = setup();
    const n = 200_000;
    const data = Array.from({ length: n }, (_, i) => ({ timestamp: i, tags: {}, values: { v: i - 7 } }));
    await service.saveBatch(data);
    const min = await service.aggregate({ metric: 'm', from: 0, to: n, field: 'v', aggregation: AggregationType.MIN });
    const max = await service.aggregate({ metric: 'm', from: 0, to: n, field: 'v', aggregation: AggregationType.MAX });
    expect(min[0].value).toBe(-7);
    expect(max[0].value).toBe(n - 8);
    await expect(service.query({ metric: 'm', from: 0, to: n })).resolves.toHaveLength(n);
  });

  it('keeps groups apart when tag values contain separators', async () => {
    const service = setup();
    await service.saveBatch([
      { timestamp: 1, tags: { a: 'x|b=y', b: '' }, values: { v: 1 } },
      { timestamp: 1, tags: { a: 'x', b: 'y' }, values: { v: 2 } },
      { timestamp: 1, tags: { a: 'p,b=q', b: 'r' }, values: { v: 3 } },
    ]);
    const grouped = await service.aggregate({
      metric: 'm', from: 0, to: 10, field: 'v', aggregation: AggregationType.SUM, groupBy: ['a', 'b'],
    });
    expect(grouped).toHaveLength(3);
    expect(grouped.map((r) => r.tags)).toEqual(expect.arrayContaining([
      { a: 'x|b=y', b: '' }, { a: 'x', b: 'y' }, { a: 'p,b=q', b: 'r' },
    ]));

    const columns = await service.aggregate({
      metric: 'm', from: 0, to: 10, field: 'v', aggregation: AggregationType.SUM, groupBy: ['a', 'b'],
      interval: 5, columns: [{ property: 'v', aggregation: AggregationType.SUM }],
    });
    expect(columns).toHaveLength(3);
    expect(columns.find((r) => r.tags?.a === 'x|b=y')).toMatchObject({ timestamp: 0, tags: { a: 'x|b=y', b: '' }, value: 1 });
  });
});
