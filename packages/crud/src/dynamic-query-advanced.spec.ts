import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  DynamicQueryParamService,
  DynamicQueryService,
  type DynamicQueryParam,
  type QueryTerm,
} from './dynamic-query.service';
import {
  FilterOperatorFactory,
  EqualsOperator,
  NotEqualsOperator,
  LikeOperator,
  ContainsOperator,
  GtOperator,
  GteOperator,
  LtOperator,
  LteOperator,
  InOperator,
  NotInOperator,
  IsNullOperator,
  BetweenOperator,
  HasOperator,
  HasSomeOperator,
} from './operators';

function createParamService(): DynamicQueryParamService {
  return new DynamicQueryParamService(
    new FilterOperatorFactory([
      new EqualsOperator(),
      new NotEqualsOperator(),
      new LikeOperator(),
      new ContainsOperator(),
      new GtOperator(),
      new GteOperator(),
      new LtOperator(),
      new LteOperator(),
      new InOperator(),
      new NotInOperator(),
      new IsNullOperator(),
      new BetweenOperator(),
      new HasOperator(),
      new HasSomeOperator(),
    ]),
  );
}

function createMockDb() {
  const modelOps = {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  };
  const db = { model: vi.fn().mockReturnValue(modelOps) } as any;
  return { db, modelOps };
}

// ---------------------------------------------------------------------------
// DynamicQueryParamService — parseFilters
// ---------------------------------------------------------------------------
describe('DynamicQueryParamService.parseFilters', () => {
  const svc = createParamService();

  it('returns empty object for empty input', () => {
    expect(svc.parseFilters({})).toEqual({});
    expect(svc.parseFilters()).toEqual({});
  });

  it('skips null, undefined and empty-string values', () => {
    expect(svc.parseFilters({ a: null, b: undefined, c: '' })).toEqual({});
  });

  it('single AND condition unwraps (no AND wrapper)', () => {
    expect(svc.parseFilters({ name: 'Alice' })).toEqual({
      name: { equals: 'Alice' },
    });
  });

  it('multiple AND conditions wrap in AND', () => {
    const result = svc.parseFilters({ name: 'Alice', status: 'active' });
    expect(result).toEqual({
      AND: [
        { name: { equals: 'Alice' } },
        { status: { equals: 'active' } },
      ],
    });
  });

  it('$or$ prefix produces OR conditions', () => {
    const result = svc.parseFilters({
      '$or$name': 'Alice',
      '$or$role': 'admin',
    });
    expect(result).toEqual({
      OR: [
        { name: { equals: 'Alice' } },
        { role: { equals: 'admin' } },
      ],
    });
  });

  it('mixed AND and $or$ uses correct SQL semantics: AND conditions AND (OR conditions)', () => {
    const result = svc.parseFilters({
      status: 'active',
      '$or$role': 'admin',
    });
    // AND conditions stay as AND, OR conditions stay as OR, combined with AND
    expect(result).toEqual({
      AND: [
        { status: { equals: 'active' } },
        { role: { equals: 'admin' } },
      ],
    });
  });

  it('$nest produces nested AND group', () => {
    const result = svc.parseFilters({
      '$nest': { a: '1', b: '2' },
    });
    expect(result).toEqual({
      AND: [
        { a: { equals: '1' } },
        { b: { equals: '2' } },
      ],
    });
  });

  it('$orNest produces nested OR group combined with AND', () => {
    const result = svc.parseFilters({
      status: 'active',
      '$orNest': { x: '1', y: '2' },
    });
    // AND(status) AND OR(x,y)
    expect(result).toHaveProperty('AND');
  });

  it('empty $nest and $orNest are ignored', () => {
    expect(svc.parseFilters({ '$nest': {} })).toEqual({});
    expect(svc.parseFilters({ '$orNest': {} })).toEqual({});
  });

  it('$or$ with operator suffix', () => {
    const result = svc.parseFilters({
      name: 'Alice',
      '$or$age$gt': 18,
    });
    // AND(name=Alice) AND OR(age>18) → simplified to AND[name, age]
    expect(result).toEqual({
      AND: [
        { name: { equals: 'Alice' } },
        { age: { gt: 18 } },
      ],
    });
  });

  it('ignores keys that resolve to an empty field name', () => {
    // "$or$" with no field after stripping → field == '' → skipped
    const result = svc.parseFilters({ '$or$': 'value' });
    // The key "$or$" → isOrType=true, fieldKey="" → dollarIdx=-1 → field="" → skip
    // But hasOrTerms is already true, so we get OR with empty array → {}
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// DynamicQueryParamService — parseOrderBy
// ---------------------------------------------------------------------------
describe('DynamicQueryParamService.parseOrderBy', () => {
  const svc = createParamService();

  it('returns default createdAt desc when no input', () => {
    expect(svc.parseOrderBy()).toEqual([{ createdAt: 'desc' }]);
    expect(svc.parseOrderBy('')).toEqual([{ createdAt: 'desc' }]);
    expect(svc.parseOrderBy('  ')).toEqual([{ createdAt: 'desc' }]);
  });

  it('uses custom default field', () => {
    expect(svc.parseOrderBy(undefined, 'updatedAt')).toEqual([{ updatedAt: 'desc' }]);
  });

  it('parses single field asc', () => {
    expect(svc.parseOrderBy('name asc')).toEqual([{ name: 'asc' }]);
  });

  it('parses single field desc', () => {
    expect(svc.parseOrderBy('name desc')).toEqual([{ name: 'desc' }]);
  });

  it('defaults to asc when direction is missing', () => {
    expect(svc.parseOrderBy('name')).toEqual([{ name: 'asc' }]);
  });

  it('parses multiple fields', () => {
    expect(svc.parseOrderBy('name desc,age asc')).toEqual([
      { name: 'desc' },
      { age: 'asc' },
    ]);
  });

  it('handles extra whitespace and empty segments', () => {
    expect(svc.parseOrderBy(' name desc , , age asc ')).toEqual([
      { name: 'desc' },
      { age: 'asc' },
    ]);
  });

  it('direction is case-insensitive', () => {
    expect(svc.parseOrderBy('name DESC')).toEqual([{ name: 'desc' }]);
    expect(svc.parseOrderBy('name ASC')).toEqual([{ name: 'asc' }]);
  });
});

// ---------------------------------------------------------------------------
// DynamicQueryParamService — parsePagination
// ---------------------------------------------------------------------------
describe('DynamicQueryParamService.parsePagination', () => {
  const svc = createParamService();

  it('defaults to page 1, pageSize 10', () => {
    expect(svc.parsePagination()).toEqual({ skip: 0, take: 10 });
  });

  it('calculates skip correctly', () => {
    expect(svc.parsePagination(3, 20)).toEqual({ skip: 40, take: 20 });
  });

  it('clamps negative page to 1', () => {
    expect(svc.parsePagination(-5, 10)).toEqual({ skip: 0, take: 10 });
  });

  it('clamps zero page to 1', () => {
    expect(svc.parsePagination(0, 10)).toEqual({ skip: 0, take: 10 });
  });

  it('clamps negative pageSize to 1', () => {
    expect(svc.parsePagination(1, -10)).toEqual({ skip: 0, take: 1 });
  });

  it('clamps zero pageSize to 1', () => {
    expect(svc.parsePagination(1, 0)).toEqual({ skip: 0, take: 1 });
  });

  it('floors floating-point page and pageSize', () => {
    expect(svc.parsePagination(2.7, 10.9)).toEqual({ skip: 10, take: 10 });
  });
});

// ---------------------------------------------------------------------------
// DynamicQueryParamService — parseSelect
// ---------------------------------------------------------------------------
describe('DynamicQueryParamService.parseSelect', () => {
  const svc = createParamService();

  it('returns undefined when no includes or excludes', () => {
    expect(svc.parseSelect()).toBeUndefined();
    expect(svc.parseSelect([], [])).toBeUndefined();
  });

  it('includes only', () => {
    expect(svc.parseSelect(['name', 'age'])).toEqual({ name: true, age: true });
  });

  it('excludes only', () => {
    expect(svc.parseSelect(undefined, ['password'])).toEqual({ password: false });
  });

  it('includes + excludes coexist', () => {
    const result = svc.parseSelect(['name', 'age', 'nickname'], ['nickname']);
    // includes set true first, then excludes set false — excludes wins for overlap
    expect(result).toEqual({ name: true, age: true, nickname: false });
  });
});

// ---------------------------------------------------------------------------
// DynamicQueryParamService — termsToWhere
// ---------------------------------------------------------------------------
describe('DynamicQueryParamService.termsToWhere', () => {
  const svc = createParamService();

  it('returns empty for empty or null terms', () => {
    expect(svc.termsToWhere([])).toEqual({});
    expect(svc.termsToWhere(null as any)).toEqual({});
  });

  it('single term unwraps', () => {
    const terms: QueryTerm[] = [
      { column: 'name', termType: 'eq', value: 'Alice' },
    ];
    expect(svc.termsToWhere(terms)).toEqual({ name: { equals: 'Alice' } });
  });

  it('multiple AND terms', () => {
    const terms: QueryTerm[] = [
      { column: 'name', termType: 'eq', value: 'Alice' },
      { column: 'age', termType: 'gt', value: 18 },
    ];
    expect(svc.termsToWhere(terms)).toEqual({
      AND: [
        { name: { equals: 'Alice' } },
        { age: { gt: 18 } },
      ],
    });
  });

  it('OR terms when type is "or"', () => {
    const terms: QueryTerm[] = [
      { column: 'name', termType: 'eq', value: 'Alice' },
      { column: 'role', termType: 'eq', value: 'admin', type: 'or' },
    ];
    expect(svc.termsToWhere(terms)).toEqual({
      OR: [
        { name: { equals: 'Alice' } },
        { role: { equals: 'admin' } },
      ],
    });
  });

  it('nest-type term processes only its sub-terms', () => {
    const terms: QueryTerm[] = [
      {
        column: '',
        termType: 'nest',
        value: null,
        terms: [
          { column: 'a', termType: 'eq', value: '1' },
          { column: 'b', termType: 'eq', value: '2' },
        ],
      },
    ];
    expect(svc.termsToWhere(terms)).toEqual({
      AND: [
        { a: { equals: '1' } },
        { b: { equals: '2' } },
      ],
    });
  });

  it('nest with empty column and sub-terms also treated as nest', () => {
    const terms: QueryTerm[] = [
      {
        column: '',
        termType: 'eq', // not 'nest', but column is '' and has sub-terms
        value: null,
        terms: [
          { column: 'x', termType: 'like', value: 'hello' },
        ],
      },
    ];
    expect(svc.termsToWhere(terms)).toEqual({
      x: { contains: 'hello', mode: 'insensitive' },
    });
  });

  it('non-nest term with sub-terms includes both own condition and nested', () => {
    const terms: QueryTerm[] = [
      {
        column: 'status',
        termType: 'eq',
        value: 'active',
        terms: [
          { column: 'role', termType: 'eq', value: 'admin' },
        ],
      },
    ];
    const result = svc.termsToWhere(terms);
    expect(result).toEqual({
      AND: [
        { status: { equals: 'active' } },
        { role: { equals: 'admin' } },
      ],
    });
  });

  it('nested terms with OR propagation', () => {
    const terms: QueryTerm[] = [
      {
        column: '',
        termType: 'nest',
        value: null,
        terms: [
          { column: 'a', termType: 'eq', value: '1' },
          { column: 'b', termType: 'eq', value: '2', type: 'or' },
        ],
      },
    ];
    expect(svc.termsToWhere(terms)).toEqual({
      OR: [
        { a: { equals: '1' } },
        { b: { equals: '2' } },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// DynamicQueryService — findMany
// ---------------------------------------------------------------------------
describe('DynamicQueryService.findMany', () => {
  it('invalid filters JSON fails closed with 400 instead of returning the unfiltered set', async () => {
    const { db, modelOps } = createMockDb();
    const service = new DynamicQueryService(db, createParamService());

    await expect(service.findMany('users', {
      filters: 'NOT_VALID_JSON{{{',
      page: 1,
      pageSize: 10,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(modelOps.count).not.toHaveBeenCalled();
    expect(modelOps.findMany).not.toHaveBeenCalled();
  });

  it('parallelPager mode runs count and findMany in parallel', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(50);
    modelOps.findMany.mockResolvedValue([{ id: '1' }]);
    const service = new DynamicQueryService(db, createParamService());

    const result = await service.findMany('users', {
      page: 1,
      pageSize: 10,
      parallelPager: true,
    });

    expect(modelOps.count).toHaveBeenCalledTimes(1);
    expect(modelOps.findMany).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(50);
    expect(result.data).toEqual([{ id: '1' }]);
    expect(result.totalPages).toBe(5);
  });

  it('clientTotal skips count query', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.findMany.mockResolvedValue([{ id: '1' }]);
    const service = new DynamicQueryService(db, createParamService());

    const result = await service.findMany('users', {
      page: 2,
      pageSize: 10,
      total: 100,
    });

    expect(modelOps.count).not.toHaveBeenCalled();
    expect(result.total).toBe(100);
    expect(result.totalPages).toBe(10);
    expect(result.page).toBe(2);
  });

  it('clientTotal=0 still skips count', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.findMany.mockResolvedValue([]);
    const service = new DynamicQueryService(db, createParamService());

    const result = await service.findMany('users', {
      page: 1,
      pageSize: 10,
      total: 0,
    });

    expect(modelOps.count).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
  });

  it('dataAccessTerms are merged into WHERE with AND', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(1);
    modelOps.findMany.mockResolvedValue([{ id: '1' }]);
    const service = new DynamicQueryService(db, createParamService());

    const dataAccessTerms: QueryTerm[] = [
      { column: 'orgId', termType: 'eq', value: 'org-1' },
    ];

    await service.findMany(
      'users',
      { filter: { status: 'active' }, page: 1, pageSize: 10 },
      undefined,
      dataAccessTerms,
    );

    expect(modelOps.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { status: { equals: 'active' } },
          { orgId: { equals: 'org-1' } },
        ],
      },
    });
  });

  it('dataAccessTerms alone (no user where) are used directly', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(1);
    modelOps.findMany.mockResolvedValue([{ id: '1' }]);
    const service = new DynamicQueryService(db, createParamService());

    await service.findMany(
      'users',
      { page: 1, pageSize: 10 },
      undefined,
      [{ column: 'orgId', termType: 'eq', value: 'org-1' }],
    );

    expect(modelOps.count).toHaveBeenCalledWith({
      where: { orgId: { equals: 'org-1' } },
    });
  });

  it('denyFields are merged into excludes', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(1);
    modelOps.findMany.mockResolvedValue([{ id: '1' }]);
    const service = new DynamicQueryService(db, createParamService());

    await service.findMany(
      'users',
      {
        page: 1,
        pageSize: 10,
        includes: ['name', 'email', 'phone'],
        excludes: ['note'],
      },
      undefined,
      undefined,
      ['phone', 'note', 'salary'],
    );

    // Included fields minus excluded / denied ones; Prisma rejects mixed true/false-only selects.
    expect(modelOps.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { name: true, email: true },
      }),
    );
  });

  it('denyFields with no user excludes', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(0);
    modelOps.findMany.mockResolvedValue([]);
    const service = new DynamicQueryService(db, createParamService());

    await service.findMany(
      'users',
      { page: 1, pageSize: 10 },
      undefined,
      undefined,
      ['password'],
    );

    // Excludes-only projection uses omit (an all-false select is rejected by Prisma).
    expect(modelOps.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        omit: { password: true },
      }),
    );
  });

  it('no-paging mode returns all data without count', async () => {
    const { db, modelOps } = createMockDb();
    const data = [{ id: '1' }, { id: '2' }, { id: '3' }];
    modelOps.findMany.mockResolvedValue(data);
    const service = new DynamicQueryService(db, createParamService());

    const result = await service.findMany('users', {});

    expect(modelOps.count).not.toHaveBeenCalled();
    expect(result.total).toBe(3);
    expect(result.pageSize).toBe(3);
    expect(result.totalPages).toBe(1);
  });

  it('filter object is used when filters string is absent', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(1);
    modelOps.findMany.mockResolvedValue([{ id: '1' }]);
    const service = new DynamicQueryService(db, createParamService());

    await service.findMany('users', {
      filter: { 'name$like': 'Alice' },
      page: 1,
      pageSize: 10,
    });

    expect(modelOps.count).toHaveBeenCalledWith({
      where: { name: { contains: 'Alice', mode: 'insensitive' } },
    });
  });

  it('filters JSON string is parsed correctly', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(1);
    modelOps.findMany.mockResolvedValue([{ id: '1' }]);
    const service = new DynamicQueryService(db, createParamService());

    await service.findMany('users', {
      filters: JSON.stringify({ 'age$gte': 18 }),
      page: 1,
      pageSize: 10,
    });

    expect(modelOps.count).toHaveBeenCalledWith({
      where: { age: { gte: 18 } },
    });
  });

  it('custom defaultOrderField is forwarded', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(0);
    modelOps.findMany.mockResolvedValue([]);
    const service = new DynamicQueryService(db, createParamService());

    await service.findMany('users', { page: 1, pageSize: 10 }, 'updatedAt');

    expect(modelOps.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: 'desc' }],
      }),
    );
  });

  it('negative page/pageSize are clamped in findMany', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.count.mockResolvedValue(10);
    modelOps.findMany.mockResolvedValue([]);
    const service = new DynamicQueryService(db, createParamService());

    const result = await service.findMany('users', {
      page: -3,
      pageSize: -5,
    });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(1);
    expect(modelOps.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// DynamicQueryService — findOne
// ---------------------------------------------------------------------------
describe('DynamicQueryService.findOne', () => {
  it('passes select to findUnique', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.findUnique.mockResolvedValue({ id: '1', name: 'Alice' });
    const service = new DynamicQueryService(db, createParamService());

    await service.findOne('users', '1', ['name'], ['password']);

    expect(modelOps.findUnique).toHaveBeenCalledWith({
      where: { id: '1' },
      select: { name: true },
    });
  });

  it('omits select when no includes/excludes', async () => {
    const { db, modelOps } = createMockDb();
    modelOps.findUnique.mockResolvedValue({ id: '1' });
    const service = new DynamicQueryService(db, createParamService());

    await service.findOne('users', '1');

    expect(modelOps.findUnique).toHaveBeenCalledWith({
      where: { id: '1' },
    });
  });
});
