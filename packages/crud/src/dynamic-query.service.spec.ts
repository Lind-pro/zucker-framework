import { describe, expect, it, vi } from 'vitest';
import {
  DynamicQueryParamService,
  DynamicQueryService,
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

describe('DynamicQueryParamService', () => {
  it('preserves top-level OR conditions from filter maps', () => {
    const service = createParamService();

    // 新语义: AND(status) AND OR(role) → 简化为 AND[status, role]
    expect(
      service.parseFilters({
        status: 'active',
        '$or$role': 'admin',
      }),
    ).toEqual({
      AND: [
        { status: { equals: 'active' } },
        { role: { equals: 'admin' } },
      ],
    });
  });

  it('preserves nested groups and operator aliases', () => {
    const service = createParamService();

    // 嵌套 $nest 内的 $or$ 也遵循新语义
    expect(
      service.parseFilters({
        '$nest': {
          status: 'active',
          '$or$role': 'admin',
        },
        'deletedAt$is-null': true,
      }),
    ).toEqual({
      AND: [
        {
          AND: [
            { status: { equals: 'active' } },
            { role: { equals: 'admin' } },
          ],
        },
        { deletedAt: { equals: null } },
      ],
    });
  });
});

describe('DynamicQueryService', () => {
  it('parses where expressions with crud term precedence', async () => {
    const modelOps = {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([{ id: '1' }]),
    };
    const db = {
      model: vi.fn().mockReturnValue(modelOps),
    } as any;
    const service = new DynamicQueryService(db, createParamService());

    await service.findMany('users', {
      where: "status = 'active' and age > 18",
      page: 1,
      pageSize: 10,
    });

    expect(modelOps.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { status: { equals: 'active' } },
          { age: { gt: 18 } },
        ],
      },
    });
  });

  it('prefers explicit terms over where and filter inputs', async () => {
    const modelOps = {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([{ id: '1' }]),
    };
    const db = {
      model: vi.fn().mockReturnValue(modelOps),
    } as any;
    const service = new DynamicQueryService(db, createParamService());

    await service.findMany('users', {
      terms: [{ column: 'status', termType: 'eq', value: 'from-terms' }],
      where: "status = 'from-where'",
      filter: { status: 'from-filter' },
      page: 1,
      pageSize: 10,
    });

    expect(modelOps.count).toHaveBeenCalledWith({
      where: { status: { equals: 'from-terms' } },
    });
  });

  it('passes structured terms to the database without flattening OR or nested groups', async () => {
    const modelOps = {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([{ id: '1' }]),
    };
    const db = {
      model: vi.fn().mockReturnValue(modelOps),
    } as any;
    const service = new DynamicQueryService(db, createParamService());
    const terms: QueryTerm[] = [
      {
        column: '',
        termType: 'nest',
        value: null,
        terms: [
          { column: 'status', termType: 'eq', value: 'active' },
          { column: 'role', termType: 'eq', value: 'admin', type: 'or' },
        ],
      },
      {
        column: 'deletedAt',
        termType: 'is-null',
        value: true,
      },
    ];

    await service.findMany('users', {
      terms,
      page: 1,
      pageSize: 10,
    });

    expect(modelOps.count).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            OR: [
              { status: { equals: 'active' } },
              { role: { equals: 'admin' } },
            ],
          },
          { deletedAt: { equals: null } },
        ],
      },
    });
    expect(modelOps.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              OR: [
                { status: { equals: 'active' } },
                { role: { equals: 'admin' } },
              ],
            },
            { deletedAt: { equals: null } },
          ],
        },
      }),
    );
  });

  it('treats missing page and pageSize as no-paging and skips count', async () => {
    const modelOps = {
      count: vi.fn(),
      findMany: vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }]),
    };
    const db = {
      model: vi.fn().mockReturnValue(modelOps),
    } as any;
    const service = new DynamicQueryService(db, createParamService());

    const result = await service.findMany('users', {
      where: "status = 'active'",
    });

    expect(modelOps.count).not.toHaveBeenCalled();
    expect(modelOps.findMany).toHaveBeenCalledWith({
      where: { status: { equals: 'active' } },
      orderBy: [{ createdAt: 'desc' }],
      take: 10000,
    });
    expect(result).toEqual({
      data: [{ id: '1' }, { id: '2' }],
      total: 2,
      page: 1,
      pageSize: 2,
      totalPages: 1,
      pageIndex: 0,
    });
  });
});


describe('SELECT-first total inference', () => {
  it.each([
    [1, 0, 0, false], [1, 2, 2, false], [2, 2, 5, false],
    [2, 0, 99, true], [1, 3, 99, true],
  ])('page %i with %i rows returns total %i', async (page, length, total, counted) => {
    const ops = { findMany: vi.fn().mockResolvedValue(Array.from({ length }, (_, id) => ({ id }))),
      count: vi.fn().mockResolvedValue(99) };
    const service = new DynamicQueryService({ model: () => ops } as never, createParamService());
    const result = await service.findMany('items', { page, pageSize: 3, inferTotal: true, orderBy: 'id asc' });
    expect(result.total).toBe(total);
    expect(ops.count).toHaveBeenCalledTimes(counted ? 1 : 0);
  });

  it.each([{ total: 8 }, { parallelPager: true }, {}])('preserves explicit total and parallel behavior %j', async extra => {
    const ops = { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(9) };
    const service = new DynamicQueryService({ model: () => ops } as never, createParamService());
    const result = await service.findMany('items', { page: 1, pageSize: 3, inferTotal: true, ...extra });
    expect(result.total).toBe('total' in extra ? 8 : 'parallelPager' in extra ? 9 : 0);
    expect(ops.count).toHaveBeenCalledTimes('parallelPager' in extra ? 1 : 0);
  });
});
