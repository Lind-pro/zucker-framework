import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import type { DatabaseAdapter, GenericEntity } from '@zucker-framework/core';
import { CrudService } from './base.service';
import { InMemoryAdapter } from './in-memory-adapter';
import { DynamicQueryParamService, DynamicQueryService } from './dynamic-query.service';
import { FilterOperatorFactory, ALL_OPERATORS } from './operators';
import type { CrudQueryPolicy } from './query/query-policy';

interface Row extends GenericEntity { name?: string }

const params = () => new DynamicQueryParamService(new FilterOperatorFactory(ALL_OPERATORS.map((Op) => new Op())));

afterEach(() => vi.restoreAllMocks());

describe('truncated unpaged results (N-L9)', () => {
  async function seed(count: number) {
    const db = new InMemoryAdapter();
    const at = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < count; i++) await db.model('rows').create({ data: { id: `r${i}`, name: `n${i}`, createdAt: at, updatedAt: at } });
    return db;
  }
  const policy: CrudQueryPolicy = { maxUnpagedRows: 3 };

  it('flags an unpaged read that reached maxUnpagedRows with truncated: true and warns', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = await seed(5);
    const service = new DynamicQueryService(db, params());
    const result = await service.findMany('rows', {}, 'createdAt', undefined, undefined, undefined, { policy });
    expect(result.data).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('does not set truncated when the result is below the limit', async () => {
    const db = await seed(2);
    const service = new DynamicQueryService(db, params());
    const result = await service.findMany('rows', {}, 'createdAt', undefined, undefined, undefined, { policy });
    expect(result.data).toHaveLength(2);
    expect(result).not.toHaveProperty('truncated');
  });

  it('never marks paged results as truncated', async () => {
    const db = await seed(5);
    const service = new DynamicQueryService(db, params());
    const result = await service.findMany('rows', { page: 1, pageSize: 3 }, 'createdAt', undefined, undefined, undefined, { policy });
    expect(result).not.toHaveProperty('truncated');
  });
});

describe('queryPager clamps pageSize before computing page bounds (N-L9)', () => {
  function mockDb(total: number) {
    const modelOps = {
      count: vi.fn().mockResolvedValue(total),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn(), createMany: vi.fn(),
    };
    const db = { model: vi.fn().mockReturnValue(modelOps), $transaction: vi.fn() } as unknown as DatabaseAdapter;
    return { db, modelOps };
  }
  class RowService extends CrudService<Row> {}

  it('pageSize 5000 uses the default maximum of 1000 for totalPages and the corrected page', async () => {
    const { db, modelOps } = mockDb(2500);
    const service = new RowService(db, new DynamicQueryService(db, params()), 'rows');
    const result = await service.queryPager({ page: 9, pageSize: 5000 });
    // 2500 rows / 1000 per page = 3 pages; page 9 is corrected to the last page.
    expect(result.pageSize).toBe(1000);
    expect(result.page).toBe(3);
    expect(modelOps.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 2000, take: 1000 }));
  });

  it('honours a service maxPageSize', async () => {
    const { db, modelOps } = mockDb(95);
    class SmallPages extends RowService {
      protected override get queryPolicy(): CrudQueryPolicy { return { maxPageSize: 20 }; }
    }
    const service = new SmallPages(db, new DynamicQueryService(db, params()), 'rows');
    const result = await service.queryPager({ page: 50, pageSize: 5000 });
    expect(result.pageSize).toBe(20);
    expect(result.page).toBe(5);
    expect(modelOps.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 80, take: 20 }));
  });

  it('keeps small page sizes unchanged', async () => {
    const { db } = mockDb(25);
    const service = new RowService(db, new DynamicQueryService(db, params()), 'rows');
    const result = await service.queryPager({ page: 2, pageSize: 10 });
    expect(result).toMatchObject({ page: 2, pageSize: 10, totalPages: 3 });
  });
});

describe('malformed filter keys are rejected (N-L9)', () => {
  const svc = params();

  it('`$nest` with a non-object value returns 400 instead of being skipped', () => {
    expect(() => svc.parseFilters({ $nest: 'x' })).toThrow(BadRequestException);
    expect(() => svc.parseFilters({ $orNest: 5 })).toThrow(BadRequestException);
  });

  it('empty field names (`$eq`, `$or$`, `$foo$bar`) return 400', () => {
    expect(() => svc.parseFilters({ $eq: 'x' })).toThrow(BadRequestException);
    expect(() => svc.parseFilters({ '$or$': 'x' })).toThrow(BadRequestException);
    expect(() => svc.parseFilters({ '$foo$bar': 'x' })).toThrow(BadRequestException);
  });

  it('valid nested groups still work', () => {
    expect(svc.parseFilters({ $nest: { name: 'a' } })).toEqual({ name: { equals: 'a' } });
  });

  it('a `$nest: "x"` filter through the service is a 400', async () => {
    const service = new DynamicQueryService(new InMemoryAdapter(), svc);
    await expect(service.findMany('rows', { filter: { $nest: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
  });
});
