import { describe, it, expect } from 'vitest';
import { QueryAnalyzer } from './query-analyzer';

describe('QueryAnalyzer.analyze', () => {
  it('should return optimized query and count query', () => {
    const result = QueryAnalyzer.analyze({
      filter: { name: 'Alice' },
      page: 1,
      pageSize: 20,
    });
    expect(result.query.filter).toEqual({ name: 'Alice' });
    expect(result.countQuery.filter).toEqual({ name: 'Alice' });
    expect(result.countQuery.orderBy).toBeUndefined();
  });

  it('should strip orderBy and select from countQuery', () => {
    const result = QueryAnalyzer.analyze({
      filter: { status: 'active' },
      orderBy: 'createdAt desc',
      page: 1,
      pageSize: 10,
    });
    expect(result.query.orderBy).toBe('createdAt desc');
    expect(result.countQuery.orderBy).toBeUndefined();
  });

  it('should deduplicate filter conditions', () => {
    const result = QueryAnalyzer.analyze({
      filter: { name: 'Alice', ' name': 'Bob', name2: 'Charlie' },
      page: 1,
      pageSize: 10,
    });
    // 'name' and ' name' (trimmed) are duplicates
    expect(result.warnings.some((w) => w.includes('Duplicate filter'))).toBe(true);
  });

  it('should deduplicate sort fields', () => {
    const result = QueryAnalyzer.analyze({
      orderBy: 'name asc,name desc,age asc',
      page: 1,
      pageSize: 10,
    });
    expect(result.warnings.some((w) => w.includes('Duplicate sort'))).toBe(true);
    expect(result.query.orderBy).toBe('name asc,age asc');
  });

  it('should warn about no pagination', () => {
    const result = QueryAnalyzer.analyze({
      filter: { name: 'test' },
    });
    expect(result.warnings.some((w) => w.includes('no pagination'))).toBe(true);
  });

  it('should warn about potential N+1 with multiple relation includes', () => {
    const result = QueryAnalyzer.analyze({
      includes: ['user.posts', 'comments'],
      page: 1,
      pageSize: 10,
    });
    expect(result.warnings.some((w) => w.includes('N+1'))).toBe(true);
  });

  it('should not warn about N+1 with single include', () => {
    const result = QueryAnalyzer.analyze({
      includes: ['posts'],
      page: 1,
      pageSize: 10,
    });
    expect(result.warnings.every((w) => !w.includes('N+1'))).toBe(true);
  });

  it('should handle empty query param', () => {
    const result = QueryAnalyzer.analyze({});
    expect(result.query).toBeDefined();
    expect(result.countQuery).toBeDefined();
    expect(result.warnings.some((w) => w.includes('no pagination'))).toBe(true);
  });

  it('should preserve filter in countQuery', () => {
    const result = QueryAnalyzer.analyze({
      filter: { status: 'active' },
      page: 1,
      pageSize: 10,
    });
    expect(result.countQuery.filter).toEqual({ status: 'active' });
  });

  it('should handle query with only orderBy', () => {
    const result = QueryAnalyzer.analyze({
      orderBy: 'createdAt desc',
      page: 1,
      pageSize: 20,
    });
    expect(result.query.orderBy).toBe('createdAt desc');
    expect(result.warnings).toHaveLength(0);
  });

  it('should handle orderBy with empty parts after split', () => {
    const result = QueryAnalyzer.analyze({
      orderBy: 'name asc,,age desc',
      page: 1,
      pageSize: 10,
    });
    expect(result.query.orderBy).toBe('name asc,age desc');
  });

  it('should preserve where and filters in countQuery', () => {
    const result = QueryAnalyzer.analyze({
      filters: '{"name$like":"test"}',
      where: 'status = active',
      page: 1,
      pageSize: 10,
    });
    expect(result.countQuery.filters).toBe('{"name$like":"test"}');
    expect(result.countQuery.where).toBe('status = active');
  });
});
