import { describe, it, expect, vi } from 'vitest';
import { QueryBuilder } from './query-builder';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';

function createMockAdapter(): DatabaseAdapter {
  const findMany = vi.fn().mockResolvedValue([]);
  const count = vi.fn().mockResolvedValue(0);
  const aggregate = vi.fn().mockResolvedValue({});
  const groupBy = vi.fn().mockResolvedValue([]);

  const model: ModelOperations = {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany,
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count,
    createMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    aggregate,
    groupBy,
  };

  return {
    model: vi.fn().mockReturnValue(model),
    $transaction: vi.fn(),
  };
}

type TestEntity = { id: string; name: string; age: number; status: string; createdAt: Date };

describe('QueryBuilder - where conditions', () => {
  it('should build eq condition via whereEq', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.whereEq('name', 'Alice').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ name: { equals: 'Alice' } });
  });

  it('should build generic where condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.where('age', 'gt', 18).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ age: { gt: 18 } });
  });

  it('should build in condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.in('status', ['active', 'pending']).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ status: { in: ['active', 'pending'] } });
  });

  it('should build notIn condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.notIn('status', ['banned']).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ status: { notIn: ['banned'] } });
  });

  it('should build like condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.like('name', 'Ali').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ name: { contains: 'Ali', mode: 'insensitive' } });
  });

  it('should build isNull condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.isNull('status').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ status: { equals: null } });
  });

  it('should build isNotNull condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.isNotNull('name').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ name: { not: null } });
  });

  it('should build between condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.between('age', 18, 65).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ age: { gte: 18, lte: 65 } });
  });

  it('should throw on unsupported operator', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await expect(qb.where('name', 'DROP TABLE', 'x').fetch()).rejects.toThrow('Unsupported query operator');
  });

  it('should build neq condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.where('status', 'neq', 'banned').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toEqual({ status: { not: 'banned' } });
  });
});

describe('QueryBuilder - compound conditions', () => {
  it('should build AND conditions', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.whereEq('name', 'Alice').where('age', 'gt', 18).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toHaveProperty('AND');
  });

  it('should build nested OR conditions', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.or((q) => q.whereEq('name', 'Alice').whereEq('name', 'Bob')).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toHaveProperty('OR');
  });

  it('should build nested AND conditions', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.and((q) => q.whereEq('name', 'Alice').where('age', 'gt', 18)).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toBeDefined();
  });
});

describe('QueryBuilder - ordering, pagination, select', () => {
  it('should build orderBy', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.orderBy('name', 'desc').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.orderBy).toEqual([{ name: 'desc' }]);
  });

  it('should default orderBy direction to asc', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.orderBy('name').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.orderBy).toEqual([{ name: 'asc' }]);
  });

  it('should build limit and offset', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.limit(10).offset(20).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.take).toBe(10);
    expect(args.skip).toBe(20);
  });

  it('should clamp negative limit to 0', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.limit(-5).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.take).toBe(0);
  });

  it('should build select fields', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.select('id', 'name').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.select).toEqual({ id: true, name: true });
  });

  it('should build distinct fields', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.distinct('status').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.distinct).toEqual(['status']);
  });
});

describe('QueryBuilder - include and join', () => {
  it('should build include', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.include('posts').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.include).toEqual({ posts: true });
  });

  it('should build join via on()', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await (qb.join('profile').on('id', 'userId') as any).fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.include).toHaveProperty('profile');
  });

  it('should merge include into select when both exist', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.select('id', 'name').include('posts').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.select).toHaveProperty('posts', true);
    expect(args.include).toBeUndefined();
  });
});

describe('QueryBuilder - fetchOne and count', () => {
  it('should fetchOne with take=1', async () => {
    const db = createMockAdapter();
    (db.model('user').findMany as any).mockResolvedValue([{ id: '1', name: 'Alice' }]);
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    const result = await qb.whereEq('id', '1').fetchOne();
    expect(result).toEqual({ id: '1', name: 'Alice' });
  });

  it('should return null when fetchOne finds nothing', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    const result = await qb.fetchOne();
    expect(result).toBeNull();
  });

  it('should execute count query', async () => {
    const db = createMockAdapter();
    (db.model('user').count as any).mockResolvedValue(42);
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    const result = await qb.whereEq('status', 'active').count();
    expect(result).toBe(42);
  });
});

describe('QueryBuilder - aggregate and groupBy', () => {
  it('should throw when model does not support aggregate', async () => {
    const db = createMockAdapter();
    (db.model('user') as any).aggregate = undefined;
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await expect(qb.aggregate({ _count: true })).rejects.toThrow('does not support aggregate');
  });

  it('should throw when model does not support groupBy', async () => {
    const db = createMockAdapter();
    (db.model('user') as any).groupBy = undefined;
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await expect(qb.fetchGroupBy({ by: ['status'] })).rejects.toThrow('does not support groupBy');
  });

  it('should call aggregate with where and args', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.whereEq('status', 'active').aggregate({ _count: true });
    expect(db.model('user').aggregate).toHaveBeenCalled();
  });
});

describe('QueryBuilder - exists/notExists', () => {
  it('should build exists condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.exists('posts').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toHaveProperty('posts');
    expect(args.where.posts).toHaveProperty('some');
  });

  it('should build notExists condition', async () => {
    const db = createMockAdapter();
    const qb = new QueryBuilder<TestEntity>(db, 'user');
    await qb.notExists('posts').fetch();
    const args = (db.model('user').findMany as any).mock.calls[0][0];
    expect(args.where).toHaveProperty('posts');
    expect(args.where.posts).toHaveProperty('none');
  });
});
