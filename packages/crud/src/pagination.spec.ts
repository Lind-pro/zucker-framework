import { describe, it, expect, vi } from 'vitest';
import {
  resolvePageTotal,
  calculateTotalPages,
  toPaginatedResult,
  rePaging,
  noPaging,
  isPaged,
} from './pagination';

describe('calculateTotalPages', () => {
  it('should calculate pages correctly', () => {
    expect(calculateTotalPages(100, 10)).toBe(10);
    expect(calculateTotalPages(101, 10)).toBe(11);
    expect(calculateTotalPages(99, 10)).toBe(10);
  });

  it('should return 0 for zero total', () => {
    expect(calculateTotalPages(0, 10)).toBe(0);
  });

  it('should return 0 for zero or negative pageSize', () => {
    expect(calculateTotalPages(100, 0)).toBe(0);
    expect(calculateTotalPages(100, -5)).toBe(0);
  });

  it('should handle single item', () => {
    expect(calculateTotalPages(1, 10)).toBe(1);
  });

  it('should handle exact multiples', () => {
    expect(calculateTotalPages(50, 25)).toBe(2);
  });
});

describe('toPaginatedResult', () => {
  it('should build paginated result', () => {
    const result = toPaginatedResult(['a', 'b'], 20, 1, 10);
    expect(result).toEqual({
      data: ['a', 'b'],
      total: 20,
      page: 1,
      pageSize: 10,
      totalPages: 2,
      pageIndex: 0,
    });
  });

  it('should handle empty data', () => {
    const result = toPaginatedResult([], 0, 1, 10);
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });
});

describe('rePaging', () => {
  it('should adjust page when exceeding total pages', () => {
    const param = { page: 10, pageSize: 10 };
    const result = rePaging(param, 50);
    // 50 items, 10 per page = 5 pages, so page 10 -> page 5
    expect(result.page).toBe(5);
    expect(result.total).toBe(50);
  });

  it('should not adjust when page is within range', () => {
    const param = { page: 3, pageSize: 10 };
    const result = rePaging(param, 100);
    expect(result.page).toBe(3);
    expect(result.total).toBe(100);
  });

  it('should handle zero total count', () => {
    const param = { page: 1, pageSize: 10 };
    const result = rePaging(param, 0);
    // totalPages is 0, but page > 0 && totalPages == 0 means no adjustment
    expect(result.page).toBe(1);
    expect(result.total).toBe(0);
  });

  it('should use defaults when page/pageSize missing', () => {
    const param = {};
    const result = rePaging(param, 100);
    // defaults: page=1, pageSize=10, totalPages=10, 1 <= 10 so no adjustment
    expect(result.total).toBe(100);
  });
});

describe('noPaging', () => {
  it('should remove page and pageSize', () => {
    const param = { page: 5, pageSize: 20, filters: 'something' };
    const result = noPaging(param);
    expect(result.page).toBeUndefined();
    expect(result.pageSize).toBeUndefined();
    expect(result.filters).toBe('something');
  });

  it('should handle undefined input', () => {
    const result = noPaging();
    expect(result.page).toBeUndefined();
    expect(result.pageSize).toBeUndefined();
  });
});

describe('isPaged', () => {
  it('should return true when both page and pageSize are set', () => {
    expect(isPaged({ page: 1, pageSize: 10 })).toBe(true);
  });

  it('should return false when page is missing', () => {
    expect(isPaged({ pageSize: 10 })).toBe(false);
  });

  it('should return false when pageSize is missing', () => {
    expect(isPaged({ page: 1 })).toBe(false);
  });

  it('should return false for empty param', () => {
    expect(isPaged({})).toBe(false);
  });
});

describe('resolvePageTotal', () => {
  it.each([[0, 0, 3, 0, false], [2, 0, 3, 2, false], [2, 3, 3, 5, false],
    [0, 6, 3, 99, true], [3, 0, 3, 99, true]])(
    'resolves %i rows at offset %i', async (rows, skip, take, total, counted) => {
      const count = vi.fn().mockResolvedValue(99);
      expect(await resolvePageTotal(rows, { skip, take }, count)).toBe(total);
      expect(count).toHaveBeenCalledTimes(counted ? 1 : 0);
    });
  it.each([{ skip: -1, take: 3 }, { skip: 0, take: 0 }, { skip: Infinity, take: 3 }])(
    'rejects invalid bounds %j', async pagination => {
      await expect(resolvePageTotal(0, pagination, async () => 0)).rejects.toThrow(RangeError);
    });
});
