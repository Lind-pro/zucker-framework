import { describe, it, expect } from 'vitest';
import { QueryParamEntity } from './dynamic-query-param-entity';

describe('QueryParamEntity - static factories', () => {
  it('should create empty entity with of()', () => {
    const entity = QueryParamEntity.of();
    expect(entity).toBeInstanceOf(QueryParamEntity);
    expect(entity.filter).toBeUndefined();
  });

  it('should create entity from DynamicQueryParam', () => {
    const entity = QueryParamEntity.of({
      page: 1,
      pageSize: 20,
      orderBy: 'name asc',
    });
    expect(entity.page).toBe(1);
    expect(entity.pageSize).toBe(20);
    expect(entity.orderBy).toBe('name asc');
  });

  it('should parse where expressions into terms', () => {
    const entity = QueryParamEntity.of({
      where: "name = 'Alice' and age > 18",
    });

    expect(entity.terms).toEqual([
      { column: 'name', termType: 'eq', value: 'Alice', type: 'and' },
      { column: 'age', termType: 'gt', value: 18, type: 'and' },
    ]);
  });

  it('should prefer explicit terms over where and filter', () => {
    const entity = QueryParamEntity.of({
      where: "status = 'from-where'",
      filter: { status: 'from-filter' },
      terms: [{ column: 'status', termType: 'eq', value: 'from-terms' }],
    });

    expect(entity.terms).toEqual([
      { column: 'status', termType: 'eq', value: 'from-terms', terms: undefined, type: undefined },
    ]);
    expect(entity.filter).toEqual({ status: 'from-terms' });
  });

  it('should create entity with field/value shorthand', () => {
    const entity = QueryParamEntity.of('name', 'Alice');
    expect(entity.filter).toBeDefined();
    expect(entity.filter!['name']).toBe('Alice');
  });

  it('should clone when passed a QueryParamEntity', () => {
    const original = QueryParamEntity.of('name', 'Alice');
    original.page = 2;
    const cloned = QueryParamEntity.of(original);
    expect(cloned.filter!['name']).toBe('Alice');
    expect(cloned.page).toBe(2);
    // Should be independent
    cloned.page = 5;
    expect(original.page).toBe(2);
  });

  it('should create via newQuery()', () => {
    const entity = QueryParamEntity.newQuery();
    expect(entity).toBeInstanceOf(QueryParamEntity);
  });
});

describe('QueryParamEntity - DSL building', () => {
  it('should add AND conditions', () => {
    const entity = QueryParamEntity.newQuery()
      .and('name', 'like', 'test')
      .and('age', 'gt', 18);
    expect(entity.filter).toBeDefined();
    expect(entity.filter!['name$like']).toBe('test');
    expect(entity.filter!['age$gt']).toBe(18);
  });

  it('should add eq condition without termType suffix', () => {
    const entity = QueryParamEntity.newQuery().and('status', 'eq', 'active');
    expect(entity.filter!['status']).toBe('active');
  });

  it('should add OR conditions with $or$ prefix', () => {
    const entity = QueryParamEntity.newQuery()
      .or('name', 'eq', 'Alice')
      .or('name', 'eq', 'Bob');
    expect(entity.filter!['$or$name']).toBeDefined();
  });

  it('should chain and/or conditions', () => {
    const entity = QueryParamEntity.newQuery()
      .and('status', 'eq', 'active')
      .or('role', 'eq', 'admin');
    expect(entity.filter!['status']).toBe('active');
    expect(entity.filter!['$or$role']).toBe('admin');
  });
});

describe('QueryParamEntity - pagination', () => {
  it('should disable paging with noPaging()', () => {
    const entity = QueryParamEntity.of({ page: 1, pageSize: 20 });
    entity.noPaging();
    expect(entity.page).toBeUndefined();
    expect(entity.pageSize).toBeUndefined();
    expect(entity.isPagingDisabled).toBe(true);
  });

  it('should set page with withPage()', () => {
    const entity = QueryParamEntity.newQuery().withPage(3, 25);
    expect(entity.page).toBe(3);
    expect(entity.pageSize).toBe(25);
    expect(entity.isPagingDisabled).toBe(false);
  });

  it('should re-enable paging after noPaging via withPage', () => {
    const entity = QueryParamEntity.newQuery().noPaging().withPage(1, 10);
    expect(entity.isPagingDisabled).toBe(false);
    expect(entity.page).toBe(1);
  });

  it('should adjust page with rePaging when exceeding total', () => {
    const entity = QueryParamEntity.of({ page: 10, pageSize: 20 });
    entity.rePaging(100); // 5 pages total
    expect(entity.page).toBe(5);
    expect(entity.total).toBe(100);
  });

  it('should not adjust page when within range', () => {
    const entity = QueryParamEntity.of({ page: 3, pageSize: 20 });
    entity.rePaging(100);
    expect(entity.page).toBe(3);
  });

  it('should handle rePaging with zero total', () => {
    const entity = QueryParamEntity.of({ page: 1, pageSize: 20 });
    entity.rePaging(0);
    // totalPages = 0, page > 0 but totalPages is 0, should not change
    expect(entity.page).toBe(1);
  });

  it('should compute getThinkPageIndex (0-based)', () => {
    const entity = QueryParamEntity.of({ page: 3 });
    expect(entity.getThinkPageIndex()).toBe(2);
  });

  it('should return 0 for getThinkPageIndex when page is undefined', () => {
    const entity = QueryParamEntity.newQuery();
    expect(entity.getThinkPageIndex()).toBe(0);
  });
});

describe('QueryParamEntity - sorting', () => {
  it('should disable sorting with doNotSort()', () => {
    const entity = QueryParamEntity.of({ orderBy: 'name asc' });
    entity.doNotSort();
    expect(entity.orderBy).toBeUndefined();
    expect(entity.isSortDisabled).toBe(true);
  });

  it('should set orderBy with withOrderBy()', () => {
    const entity = QueryParamEntity.newQuery().withOrderBy('createdAt desc');
    expect(entity.orderBy).toBe('createdAt desc');
    expect(entity.isSortDisabled).toBe(false);
  });

  it('should re-enable sorting after doNotSort via withOrderBy', () => {
    const entity = QueryParamEntity.newQuery().doNotSort().withOrderBy('id asc');
    expect(entity.isSortDisabled).toBe(false);
  });
});

describe('QueryParamEntity - clone', () => {
  it('should deep clone filter', () => {
    const entity = QueryParamEntity.newQuery().and('name', 'eq', 'Alice');
    const cloned = entity.clone();
    cloned.filter!['name'] = 'Bob';
    expect(entity.filter!['name']).toBe('Alice');
  });

  it('should clone includes array independently', () => {
    const entity = QueryParamEntity.newQuery().withIncludes('name', 'age');
    const cloned = entity.clone();
    cloned.includes!.push('extra');
    expect(entity.includes).toHaveLength(2);
  });

  it('should clone paging/sorting state', () => {
    const entity = QueryParamEntity.newQuery().noPaging().doNotSort();
    const cloned = entity.clone();
    expect(cloned.isPagingDisabled).toBe(true);
    expect(cloned.isSortDisabled).toBe(true);
  });
});

describe('QueryParamEntity - toNestQuery', () => {
  it('should wrap existing filter into $nest', () => {
    const entity = QueryParamEntity.newQuery()
      .and('name', 'eq', 'Alice')
      .and('type', 'eq', 'admin');
    entity.toNestQuery();
    expect(entity.filter).toHaveProperty('$nest');
  });

  it('should allow adding outer conditions after nesting', () => {
    const entity = QueryParamEntity.newQuery()
      .and('name', 'eq', 'Alice')
      .toNestQuery()
      .and('userId', 'eq', 'user1');
    expect(entity.filter!['$nest']).toBeDefined();
    expect(entity.filter!['userId']).toBe('user1');
  });

  it('should preserve where expressions when nesting', () => {
    const entity = QueryParamEntity.of({
      where: "name = 'Alice' or type = 'admin'",
    })
      .toNestQuery()
      .and('userId', 'eq', 'user1');

    expect(entity.terms).toEqual([
      {
        column: '',
        termType: 'nest',
        value: null,
        type: 'and',
        terms: [
          { column: 'name', termType: 'eq', value: 'Alice', type: 'and' },
          { column: 'type', termType: 'eq', value: 'admin', type: 'or' },
        ],
      },
      { column: 'userId', termType: 'eq', value: 'user1', type: 'and' },
    ]);
    expect(entity.filter).toEqual({
      '$nest': {
        name: 'Alice',
        '$or$type': 'admin',
      },
      userId: 'user1',
    });
  });

  it('should be no-op when no conditions exist', () => {
    const entity = QueryParamEntity.newQuery();
    entity.toNestQuery();
    expect(entity.filter).toBeUndefined();
  });
});

describe('QueryParamEntity - withFilter, withIncludes, withExcludes', () => {
  it('should add filter via withFilter', () => {
    const entity = QueryParamEntity.newQuery().withFilter('status', 'active');
    expect(entity.filter!['status']).toBe('active');
  });

  it('should initialize filter if not set', () => {
    const entity = new QueryParamEntity();
    entity.withFilter('key', 'value');
    expect(entity.filter).toEqual({ key: 'value' });
  });

  it('should set includes via withIncludes', () => {
    const entity = QueryParamEntity.newQuery().withIncludes('name', 'age', 'email');
    expect(entity.includes).toEqual(['name', 'age', 'email']);
  });

  it('should set excludes via withExcludes', () => {
    const entity = QueryParamEntity.newQuery().withExcludes('password', 'secret');
    expect(entity.excludes).toEqual(['password', 'secret']);
  });
});
