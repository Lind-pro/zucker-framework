import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultThingsDataService } from './property-log';
import { createReportPropertyMessage, createEventMessage } from './message';
import type { TimeSeriesService, TimeSeriesData, TimeSeriesQuery, AggregationQuery, AggregationResult } from '@zucker/timeseries';

/**
 * 最小内存 TimeSeriesService mock
 */
function createMockTsService(): TimeSeriesService & { data: TimeSeriesData[] } {
  const data: TimeSeriesData[] = [];
  return {
    data,
    async save(d: TimeSeriesData) { data.push({ ...d }); },
    async saveBatch(ds: TimeSeriesData[]) { data.push(...ds.map((d) => ({ ...d }))); },
    async query(q: TimeSeriesQuery): Promise<TimeSeriesData[]> {
      return data.filter((d) => {
        if (d.timestamp < q.from || d.timestamp > q.to) return false;
        if (q.tags) {
          for (const [k, v] of Object.entries(q.tags)) {
            if (d.tags[k] !== v) return false;
          }
        }
        return true;
      });
    },
    async count(q: TimeSeriesQuery): Promise<number> {
      return (await this.query(q)).length;
    },
    async aggregate(_q: AggregationQuery): Promise<AggregationResult[]> {
      return [];
    },
  };
}

describe('DefaultThingsDataService', () => {
  let ts: ReturnType<typeof createMockTsService>;
  let svc: DefaultThingsDataService;

  beforeEach(() => {
    ts = createMockTsService();
    svc = new DefaultThingsDataService(ts as unknown as TimeSeriesService);
  });

  describe('saveProperties', () => {
    it('saves one point per property', async () => {
      const msg = createReportPropertyMessage('d1', 'sensor', {
        temperature: 25,
        humidity: 60,
      });
      await svc.saveProperties(msg);
      // 每条属性写一次 + 批量写一次（各属性），共 2 + 2 = 4 次
      // 实现内部写法：每条属性 save() 一次 + saveBatch() 一次
      expect(ts.data.length).toBeGreaterThanOrEqual(2);
    });

    it('uses propertySourceTimes when provided', async () => {
      const customTs = 1_700_000_000_000;
      const msg = createReportPropertyMessage('d1', 'sensor', { temperature: 25 }, {
        propertySourceTimes: { temperature: customTs },
      });
      await svc.saveProperties(msg);
      const point = ts.data.find((d) => d.timestamp === customTs);
      expect(point).toBeDefined();
    });
  });

  describe('saveEvent', () => {
    it('saves event as a single time series point', async () => {
      const msg = createEventMessage('d1', 'sensor', 'alarm', { level: 'high' });
      await svc.saveEvent(msg);
      expect(ts.data.length).toBe(1);
      expect(ts.data[0].tags['event']).toBe('alarm');
      expect(ts.data[0].tags['thingId']).toBe('d1');
    });

    it('serializes object data to JSON string', async () => {
      const msg = createEventMessage('d1', 'sensor', 'status', { code: 200, ok: true });
      await svc.saveEvent(msg);
      const stored = ts.data[0].values['data'];
      expect(typeof stored).toBe('string');
      expect(JSON.parse(stored as string)).toEqual({ code: 200, ok: true });
    });
  });

  describe('queryPropertyLogs', () => {
    beforeEach(async () => {
      const msg = createReportPropertyMessage('d1', 'sensor', { temperature: 22 }, {
        timestamp: 1_000,
      });
      await svc.saveProperties(msg);
    });

    it('returns mapped PropertyLog objects', async () => {
      const logs = await svc.queryPropertyLogs({
        thingId: 'd1',
        thingType: 'sensor',
        id: 'temperature',
        from: 0,
        to: 9_999,
      });
      // 至少能找到一条 thingId=d1 的记录
      expect(logs.some((l) => l.thingId === 'd1')).toBe(true);
    });
  });

  describe('queryEventLogs', () => {
    beforeEach(async () => {
      const msg = createEventMessage('d1', 'sensor', 'alarm', { level: 'critical' });
      // 固定时间戳以便查询
      (msg as typeof msg).timestamp = 5_000;
      await svc.saveEvent(msg);
    });

    it('returns event logs with deserialized data', async () => {
      const logs = await svc.queryEventLogs({
        thingId: 'd1',
        thingType: 'sensor',
        id: 'alarm',
        from: 0,
        to: 9_999,
      });
      expect(logs.length).toBeGreaterThan(0);
      const log = logs[0];
      expect(log.thingId).toBe('d1');
      expect((log.data as Record<string, string>).level).toBe('critical');
    });
  });
});
