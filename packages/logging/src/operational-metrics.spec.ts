// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { OperationalMetricsService } from './operational-metrics';

describe('login operational metrics', () => {
  it('aggregates logins using one time window and keeps application user records outside the query', async () => {
    const groups = vi.fn(async ({ by }: { by: string[]; where: { createdAt: { gte: Date } } }) => {
      if (by[0] === 'userId') return [{ userId: 'one' }, { userId: 'two' }];
      if (by[0] === 'loginMethod') return [{ loginMethod: 'password', _count: { id: 3 } }];
      return [{ ip: '192.0.2.1', _count: { id: 2 } }];
    });
    const count = vi.fn().mockResolvedValue(3);
    const model = vi.fn(() => ({ groupBy: groups, count }));
    const service = new OperationalMetricsService({
      database: { model } as unknown as DatabaseAdapter,
      query: async () => [],
      accessTable: 'access_history',
      loginTable: 'login_history',
      loginModel: 'signIns',
      sensitiveModules: [],
    });
    expect(await service.getLoginStats(24)).toEqual({
      login: { totalLogins: 3, uniqueUsers: 2, byMethod: [{ method: 'password', count: 3 }] },
      failedLoginIPs: [{ ip: '192.0.2.1', count: 2 }],
    });
    expect(model).toHaveBeenCalledWith('signIns');
    const since = count.mock.calls[0][0].where.createdAt.gte;
    for (const [args] of groups.mock.calls) expect(args.where.createdAt.gte).toEqual(since);
  });
  it('uses the configured unknown-country label while retaining the top-country bound', async () => {
    const groupBy = vi.fn().mockResolvedValue([{ country: '', _count: { id: 1 } }]);
    const service = new OperationalMetricsService({
      database: { model: () => ({ groupBy }) } as unknown as DatabaseAdapter,
      query: async () => [],
      accessTable: 'access_history',
      loginTable: 'login_history',
      sensitiveModules: [],
      unknownCountryLabel: '未知',
    });
    expect(await service.getGeographicDistribution(24)).toEqual({
      byCountry: [{ country: '未知', count: 1 }],
    });
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ take: 20, by: ['country'] }));
  });
});
