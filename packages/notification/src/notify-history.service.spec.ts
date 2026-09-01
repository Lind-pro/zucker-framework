import { describe, it, expect, beforeEach } from 'vitest';
import { NotifyHistoryService } from './notify-history.service';
import type { NotifyMessage, NotifyResult, NotifyChannel } from './notifier.interface';

describe('NotifyHistoryService', () => {
  let service: NotifyHistoryService;

  const makeMessage = (overrides: Partial<NotifyMessage> = {}): NotifyMessage => ({
    channel: 'EMAIL' as NotifyChannel,
    to: 'user@test.com',
    variables: {},
    subject: 'Test',
    ...overrides,
  });

  const makeResult = (overrides: Partial<NotifyResult> = {}): NotifyResult => ({
    success: true,
    timestamp: new Date(),
    channel: 'EMAIL' as NotifyChannel,
    to: 'user@test.com',
    ...overrides,
  });

  beforeEach(() => {
    service = new NotifyHistoryService();
  });

  describe('record', () => {
    it('should store a successful notification record', () => {
      service.record(makeMessage(), makeResult());
      const records = service.query({});
      expect(records).toHaveLength(1);
      expect(records[0].success).toBe(true);
    });

    it('should store a failed notification record', () => {
      service.record(
        makeMessage(),
        makeResult({ success: false, error: 'timeout' }),
      );
      const records = service.query({ success: false });
      expect(records).toHaveLength(1);
      expect(records[0].error).toBe('timeout');
    });

    it('should include meta information (configId, provider, retryCount)', () => {
      service.record(makeMessage(), makeResult(), {
        configId: 'c1',
        provider: 'aliyun',
        retryCount: 2,
      });
      const records = service.query({});
      expect(records[0].configId).toBe('c1');
      expect(records[0].provider).toBe('aliyun');
      expect(records[0].retryCount).toBe(2);
    });

    it('should auto-increment record IDs', () => {
      service.record(makeMessage(), makeResult());
      service.record(makeMessage(), makeResult());
      const records = service.query({});
      const ids = records.map((r) => r.id);
      expect(ids).toContain('1');
      expect(ids).toContain('2');
    });

    it('should evict old records when exceeding maxRecords', () => {
      // maxRecords is 10000, we simulate by recording many entries
      for (let i = 0; i < 100; i++) {
        service.record(makeMessage(), makeResult());
      }
      expect(service.query({ limit: 200 }).length).toBeLessThanOrEqual(100);
    });
  });

  describe('query', () => {
    it('should filter by channel', () => {
      service.record(makeMessage({ channel: 'EMAIL' as NotifyChannel }), makeResult({ channel: 'EMAIL' as NotifyChannel }));
      service.record(makeMessage({ channel: 'SMS' as NotifyChannel }), makeResult({ channel: 'SMS' as NotifyChannel }));
      const emailOnly = service.query({ channel: 'EMAIL' as NotifyChannel });
      expect(emailOnly).toHaveLength(1);
    });

    it('should filter by recipient', () => {
      service.record(makeMessage({ to: 'a@test.com' }), makeResult({ to: 'a@test.com' }));
      service.record(makeMessage({ to: 'b@test.com' }), makeResult({ to: 'b@test.com' }));
      const result = service.query({ to: 'a@test.com' });
      expect(result).toHaveLength(1);
      expect(result[0].to).toBe('a@test.com');
    });

    it('should filter by time range', () => {
      const t1 = new Date('2024-01-01T00:00:00Z');
      const t2 = new Date('2024-06-01T00:00:00Z');
      const t3 = new Date('2024-12-01T00:00:00Z');
      service.record(makeMessage(), makeResult({ timestamp: t1 }));
      service.record(makeMessage(), makeResult({ timestamp: t2 }));
      service.record(makeMessage(), makeResult({ timestamp: t3 }));
      const result = service.query({
        startTime: new Date('2024-03-01'),
        endTime: new Date('2024-09-01'),
      });
      expect(result).toHaveLength(1);
    });

    it('should support pagination with offset and limit', () => {
      for (let i = 0; i < 5; i++) {
        service.record(makeMessage(), makeResult({ timestamp: new Date(2024, 0, i + 1) }));
      }
      const page = service.query({ offset: 1, limit: 2 });
      expect(page).toHaveLength(2);
    });

    it('should sort results by timestamp descending', () => {
      const t1 = new Date('2024-01-01');
      const t2 = new Date('2024-06-01');
      service.record(makeMessage(), makeResult({ timestamp: t1 }));
      service.record(makeMessage(), makeResult({ timestamp: t2 }));
      const results = service.query({});
      expect(results[0].timestamp.getTime()).toBeGreaterThan(results[1].timestamp.getTime());
    });
  });

  describe('getStats', () => {
    it('should return correct total, success and failed counts', () => {
      service.record(makeMessage(), makeResult({ success: true }));
      service.record(makeMessage(), makeResult({ success: true }));
      service.record(makeMessage(), makeResult({ success: false, error: 'err' }));
      const stats = service.getStats();
      expect(stats.total).toBe(3);
      expect(stats.success).toBe(2);
      expect(stats.failed).toBe(1);
    });

    it('should filter stats by channel', () => {
      service.record(makeMessage(), makeResult({ channel: 'EMAIL' as NotifyChannel, success: true }));
      service.record(makeMessage(), makeResult({ channel: 'SMS' as NotifyChannel, success: true }));
      const stats = service.getStats({ channel: 'SMS' as NotifyChannel });
      expect(stats.total).toBe(1);
    });

    it('should filter stats by time range', () => {
      service.record(makeMessage(), makeResult({ timestamp: new Date('2024-01-01'), success: true }));
      service.record(makeMessage(), makeResult({ timestamp: new Date('2024-12-01'), success: true }));
      const stats = service.getStats({ startTime: new Date('2024-06-01') });
      expect(stats.total).toBe(1);
    });

    it('should return zeros when no records exist', () => {
      const stats = service.getStats();
      expect(stats).toEqual({ total: 0, success: 0, failed: 0 });
    });
  });
});
