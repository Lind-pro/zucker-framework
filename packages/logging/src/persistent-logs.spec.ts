import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { AccessLogService, OperationLogService } from './persistent-logs';
import { LogSanitizer } from './log-sanitizer';

const model = () => ({
  create: vi.fn().mockResolvedValue({ id: 'written' }),
  findMany: vi.fn().mockResolvedValue([]),
  findUnique: vi.fn().mockResolvedValue(null),
  count: vi.fn().mockResolvedValue(0),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  aggregate: vi.fn().mockResolvedValue({ _avg: {} }),
  groupBy: vi.fn().mockResolvedValue([]),
});
const access = model();
const operation = model();
const db: DatabaseAdapter = {
  model: (name) =>
    ({ accessLogs: access, operationLogs: operation })[name] as unknown as ModelOperations,
  $transaction: (work) => work(db),
};
const sanitizer = new LogSanitizer({ sensitiveFields: ['privateDocument'], maxStringLength: 2000 });

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of [access, operation]) {
    m.create.mockResolvedValue({ id: 'written' });
    m.findMany.mockResolvedValue([]);
    m.count.mockResolvedValue(0);
    m.deleteMany.mockResolvedValue({ count: 0 });
    m.aggregate.mockResolvedValue({ _avg: {} });
    m.groupBy.mockResolvedValue([]);
  }
});

describe('database-backed logging', () => {
  it('redacts write payloads and normalizes non-string errors before storage', async () => {
    await new AccessLogService(db, sanitizer).log({
      action: 'save',
      requestUrl: '/records?token=secret',
      ip: '192.0.2.10',
      parameters: { privateDocument: 'private content', password: 'secret', recordId: 'r1' },
      exception: { message: 'password=secret' } as unknown as string,
    });
    expect(access.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestUrl: '/records?token=[REDACTED]',
        ip: '192.0.2.10',
        parameters: { privateDocument: '[REDACTED]', password: '[REDACTED]', recordId: 'r1' },
        exception: expect.not.stringContaining('secret'),
      }),
    });
    await new OperationLogService(db, sanitizer).log({
      module: 'records',
      action: 'create',
      requestData: { privateDocument: 'private content' },
    });
    expect(operation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'SUCCESS',
        requestData: { privateDocument: '[REDACTED]' },
      }),
    });
  });

  it('keeps both log kinds best effort and accounts for failed writes', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      access.create.mockRejectedValue(new Error('database password=secret'));
      operation.create.mockRejectedValue(new Error('database unavailable'));
      const a = new AccessLogService(db, sanitizer),
        o = new OperationLogService(db, sanitizer);
      await expect(a.log({ action: 'save' })).resolves.toBeUndefined();
      await expect(o.log({ module: 'records', action: 'save' })).resolves.toBeUndefined();
      for (const service of [a, o])
        expect(service.getMetrics()).toMatchObject({
          totalLogs: 1,
          successCount: 0,
          failureCount: 1,
        });
      expect(error.mock.calls.flat().join(' ')).not.toContain('=secret');
    } finally {
      error.mockRestore();
    }
  });

  it('queries the database for each page rather than retaining a process-local snapshot', async () => {
    const startDate = new Date('2026-01-01'),
      endDate = new Date('2026-02-01');
    access.findMany
      .mockResolvedValueOnce([{ id: 'row-1' }])
      .mockResolvedValueOnce([{ id: 'row-2' }]);
    access.count.mockResolvedValue(205);
    const service = new AccessLogService(db, sanitizer);
    const filter = {
      module: 'records',
      ip: '192.0.2.10',
      startDate,
      endDate,
      page: 2,
      pageSize: 200,
    };
    expect(await service.findAll(filter)).toMatchObject({
      data: [{ id: 'row-1' }],
      total: 205,
      page: 2,
      pageSize: 100,
    });
    expect(await new AccessLogService(db, sanitizer).findAll(filter)).toMatchObject({
      data: [{ id: 'row-2' }],
    });
    expect(access.findMany).toHaveBeenCalledWith({
      where: { module: 'records', ip: '192.0.2.10', requestTime: { gte: startDate, lte: endDate } },
      orderBy: { requestTime: 'desc' },
      skip: 100,
      take: 100,
    });
  });

  it('merges and orders access/operation timelines and counts distinct users', async () => {
    access.findMany.mockResolvedValue([
      { id: 'a', userId: 'u1', requestTime: new Date('2026-01-01'), userAgent: 'agent' },
    ]);
    operation.findMany.mockResolvedValue([
      { id: 'o', userId: 'u1', createdAt: new Date('2026-01-02') },
    ]);
    const result = await new AccessLogService(db, sanitizer).getIpTimeline('192.0.2.10');
    expect(result).toMatchObject({
      totalEvents: 2,
      uniqueUserCount: 1,
      userIds: ['u1'],
      userAgent: 'agent',
    });
    expect(result.timeline.map((row) => row.source)).toEqual(['operation', 'access']);
    expect(operation.findMany.mock.calls[0][0].where.ipAddress).toBe('192.0.2.10');
  });

  it('uses database aggregates for module statistics', async () => {
    operation.count.mockResolvedValueOnce(10).mockResolvedValueOnce(8).mockResolvedValueOnce(2);
    operation.aggregate.mockResolvedValue({ _avg: { duration: 12.6 } });
    operation.groupBy.mockResolvedValue([{ action: 'save', _count: { _all: 10 } }]);
    expect(await new OperationLogService(db).getModuleStatistics('records')).toEqual({
      module: 'records',
      total: 10,
      successCount: 8,
      failedCount: 2,
      successRate: '80.00',
      avgDuration: 13,
      actionStats: [{ action: 'save', count: 10 }],
    });
  });

  it('limits bulk deletion and preserves the time field for each retention policy', async () => {
    const a = new AccessLogService(db),
      o = new OperationLogService(db);
    await expect(a.batchDelete([])).rejects.toThrow('不能为空');
    await expect(o.batchDelete(Array(1001).fill('id'))).rejects.toThrow('1000');
    expect(operation.deleteMany).not.toHaveBeenCalled();
    operation.deleteMany.mockResolvedValue({ count: 2 });
    expect(await o.batchDelete(['one', 'two'])).toEqual({
      success: true,
      requested: 2,
      deletedCount: 2,
    });
    await a.cleanOldLogs(30);
    await o.cleanOldLogs(90);
    expect(access.deleteMany).toHaveBeenCalledWith({
      where: { requestTime: { lt: expect.any(Date) } },
    });
    expect(operation.deleteMany).toHaveBeenLastCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
  });

  it('exports quoted CSV without allowing user text to become spreadsheet formulas', async () => {
    access.findMany.mockResolvedValue([
      {
        id: 'a',
        action: '=HYPERLINK("https://example.test")',
        describe: 'line1\nline2',
        requestTime: new Date('2026-01-01'),
      },
    ]);
    const csv = await new AccessLogService(db).exportToCsv({ module: 'records', limit: 5 });
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain('2026-01-01T00:00:00.000Z');
    expect(access.findMany).toHaveBeenCalledWith({
      where: { module: 'records' },
      orderBy: { requestTime: 'desc' },
      take: 5,
    });
  });
});
