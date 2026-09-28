import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { AccessLogService, OperationLogService } from './persistent-logs';

describe.each([AccessLogService, OperationLogService])('persistent log query boundaries: %s', Service => {
  function setup() {
    const model = { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) };
    return { model, service: new Service({ model: () => model } as unknown as DatabaseAdapter) };
  }
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid numeric inputs before storage: %s', async value => {
    const { service, model } = setup();
    await expect(service.findAll({ page: value })).rejects.toThrow(RangeError);
    await expect(service.findAll({ pageSize: value })).rejects.toThrow(RangeError);
    await expect(service.exportToCsv({ limit: value })).rejects.toThrow(RangeError);
    expect(model.findMany).not.toHaveBeenCalled();
    expect(model.count).not.toHaveBeenCalled();
  });
  it('rejects invalid dates, reversed ranges and oversized exports', async () => {
    const { service, model } = setup();
    await expect(service.findAll({ startDate: new Date('bad') })).rejects.toThrow(RangeError);
    await expect(service.exportToCsv({ startDate: new Date(2), endDate: new Date(1) })).rejects.toThrow(RangeError);
    await expect(service.exportToCsv({ limit: 10001 })).rejects.toThrow(RangeError);
    await expect(service.findAll({ page: Number.MAX_SAFE_INTEGER })).rejects.toThrow(RangeError);
    expect(model.findMany).not.toHaveBeenCalled();
  });
  it('preserves defaults and page-size cap and passes valid dates', async () => {
    const { service, model } = setup();
    expect(await service.findAll({})).toMatchObject({ page: 1, pageSize: 20 });
    const startDate = new Date(0);
    expect(await service.findAll({ page: 2, pageSize: 200, startDate })).toMatchObject({ page: 2, pageSize: 100 });
    expect(model.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 100, take: 100 }));
    await service.exportToCsv({ limit: 10000, startDate, endDate: startDate });
    expect(model.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 10000 }));
  });
});
