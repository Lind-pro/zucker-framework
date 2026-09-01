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
  it('parses where expressions with hsweb-style term precedence', async () => {
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
