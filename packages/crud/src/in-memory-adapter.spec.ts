import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAdapter } from './in-memory-adapter';
import type { ModelOperations } from '@zucker-framework/core';

describe('InMemoryAdapter', () => {
  let adapter: InMemoryAdapter;
  let model: ModelOperations;

  beforeEach(() => {
    adapter = new InMemoryAdapter();
    model = adapter.model('test');
  });

  // -------------------------------------------------------------------------
  // Basic CRUD
  // -------------------------------------------------------------------------
  describe('basic CRUD', () => {
    it('create — auto-generates id', async () => {
      const record = await model.create({ data: { name: 'Alice' } });
      expect(record).toHaveProperty('id');
      expect((record as any).name).toBe('Alice');
    });

    it('create — uses provided id', async () => {
      const record = await model.create({ data: { id: 'custom-1', name: 'Bob' } });
      expect((record as any).id).toBe('custom-1');
    });

    it('findUnique — returns matching record', async () => {
      await model.create({ data: { id: '1', name: 'Alice' } });
      const found = await model.findUnique({ where: { id: '1' } });
      expect((found as any).name).toBe('Alice');
    });

    it('findUnique — returns null when not found', async () => {
      const found = await model.findUnique({ where: { id: 'missing' } });
      expect(found).toBeNull();
    });

    it('findMany — returns all records when no filter', async () => {
      await model.create({ data: { id: '1', name: 'A' } });
      await model.create({ data: { id: '2', name: 'B' } });
      const all = await model.findMany();
      expect(all).toHaveLength(2);
    });

    it('update — modifies existing record', async () => {
      await model.create({ data: { id: '1', name: 'Old' } });
      const updated = await model.update({ where: { id: '1' }, data: { name: 'New' } });
      expect((updated as any).name).toBe('New');
      const fetched = await model.findUnique({ where: { id: '1' } });
      expect((fetched as any).name).toBe('New');
    });

    it('update — throws when record not found', async () => {
      await expect(
        model.update({ where: { id: 'missing' }, data: { name: 'X' } }),
      ).rejects.toThrow('Record not found');
    });

    it('delete — removes record', async () => {
      await model.create({ data: { id: '1', name: 'Alice' } });
      const deleted = await model.delete({ where: { id: '1' } });
      expect((deleted as any).name).toBe('Alice');
      const found = await model.findUnique({ where: { id: '1' } });
      expect(found).toBeNull();
    });

    it('delete — throws when record not found', async () => {
      await expect(
        model.delete({ where: { id: 'missing' } }),
      ).rejects.toThrow('Record not found');
    });
  });

  // -------------------------------------------------------------------------
  // Where filters — comparison operators
  // -------------------------------------------------------------------------
  describe('where filters — comparison', () => {
    beforeEach(async () => {
      await model.create({ data: { id: '1', age: 10, name: 'Alice' } });
      await model.create({ data: { id: '2', age: 20, name: 'Bob' } });
      await model.create({ data: { id: '3', age: 30, name: 'Charlie' } });
    });

    it('equals', async () => {
      const results = await model.findMany({ where: { age: { equals: 20 } } });
      expect(results).toHaveLength(1);
      expect((results[0] as any).name).toBe('Bob');
    });

    it('not', async () => {
      const results = await model.findMany({ where: { age: { not: 20 } } });
      expect(results).toHaveLength(2);
    });

    it('in', async () => {
      const results = await model.findMany({ where: { age: { in: [10, 30] } } });
      expect(results).toHaveLength(2);
    });

    it('notIn', async () => {
      const results = await model.findMany({ where: { age: { notIn: [10, 30] } } });
      expect(results).toHaveLength(1);
      expect((results[0] as any).name).toBe('Bob');
    });

    it('gt', async () => {
      const results = await model.findMany({ where: { age: { gt: 20 } } });
      expect(results).toHaveLength(1);
      expect((results[0] as any).name).toBe('Charlie');
    });

    it('gte', async () => {
      const results = await model.findMany({ where: { age: { gte: 20 } } });
      expect(results).toHaveLength(2);
    });

    it('lt', async () => {
      const results = await model.findMany({ where: { age: { lt: 20 } } });
      expect(results).toHaveLength(1);
      expect((results[0] as any).name).toBe('Alice');
    });

    it('lte', async () => {
      const results = await model.findMany({ where: { age: { lte: 20 } } });
      expect(results).toHaveLength(2);
    });

    it('gt/lt return false for null/undefined values', async () => {
      await model.create({ data: { id: '4', age: null, name: 'NoAge' } });
      const results = await model.findMany({ where: { age: { gt: 0 } } });
      expect(results.every((r: any) => r.name !== 'NoAge')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // String operations
  // -------------------------------------------------------------------------
  describe('string operations', () => {
    beforeEach(async () => {
      await model.create({ data: { id: '1', name: 'Hello World' } });
      await model.create({ data: { id: '2', name: 'hello test' } });
      await model.create({ data: { id: '3', name: 'Goodbye' } });
    });

    it('contains', async () => {
      const results = await model.findMany({ where: { name: { contains: 'World' } } });
      expect(results).toHaveLength(1);
    });

    it('contains — insensitive', async () => {
      const results = await model.findMany({
        where: { name: { contains: 'hello', mode: 'insensitive' } },
      });
      expect(results).toHaveLength(2);
    });

    it('startsWith', async () => {
      const results = await model.findMany({ where: { name: { startsWith: 'Hello' } } });
      expect(results).toHaveLength(1);
    });

    it('startsWith — insensitive', async () => {
      const results = await model.findMany({
        where: { name: { startsWith: 'hello', mode: 'insensitive' } },
      });
      expect(results).toHaveLength(2);
    });

    it('endsWith', async () => {
      const results = await model.findMany({ where: { name: { endsWith: 'bye' } } });
      expect(results).toHaveLength(1);
      expect((results[0] as any).name).toBe('Goodbye');
    });

    it('endsWith — insensitive', async () => {
      const results = await model.findMany({
        where: { name: { endsWith: 'WORLD', mode: 'insensitive' } },
      });
      expect(results).toHaveLength(1);
    });

    it('string ops return false for non-string fields', async () => {
      await model.create({ data: { id: '4', name: 123 } });
      const results = await model.findMany({ where: { name: { contains: '12' } } });
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // JSON array operations
  // -------------------------------------------------------------------------
  describe('JSON array operations', () => {
    beforeEach(async () => {
      await model.create({ data: { id: '1', tags: ['a', 'b', 'c'] } });
      await model.create({ data: { id: '2', tags: ['b', 'c', 'd'] } });
      await model.create({ data: { id: '3', tags: [] } });
    });

    it('has', async () => {
      const results = await model.findMany({ where: { tags: { has: 'a' } } });
      expect(results).toHaveLength(1);
      expect((results[0] as any).id).toBe('1');
    });

    it('hasEvery', async () => {
      const results = await model.findMany({ where: { tags: { hasEvery: ['b', 'c'] } } });
      expect(results).toHaveLength(2);
    });

    it('hasSome', async () => {
      const results = await model.findMany({ where: { tags: { hasSome: ['a', 'd'] } } });
      expect(results).toHaveLength(2);
    });

    it('isEmpty — true', async () => {
      const results = await model.findMany({ where: { tags: { isEmpty: true } } });
      expect(results).toHaveLength(1);
      expect((results[0] as any).id).toBe('3');
    });

    it('isEmpty — false', async () => {
      const results = await model.findMany({ where: { tags: { isEmpty: false } } });
      expect(results).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Logical combinators
  // -------------------------------------------------------------------------
  describe('logical combinators', () => {
    beforeEach(async () => {
      await model.create({ data: { id: '1', age: 10, name: 'Alice' } });
      await model.create({ data: { id: '2', age: 20, name: 'Bob' } });
      await model.create({ data: { id: '3', age: 30, name: 'Charlie' } });
    });

    it('AND', async () => {
      const results = await model.findMany({
        where: { AND: [{ age: { gte: 10 } }, { age: { lte: 20 } }] },
      });
      expect(results).toHaveLength(2);
    });

    it('OR', async () => {
      const results = await model.findMany({
        where: { OR: [{ name: 'Alice' }, { name: 'Charlie' }] },
      });
      expect(results).toHaveLength(2);
    });

    it('NOT', async () => {
      const results = await model.findMany({
        where: { NOT: { name: 'Bob' } },
      });
      expect(results).toHaveLength(2);
      expect(results.every((r: any) => r.name !== 'Bob')).toBe(true);
    });

    it('AND as single object (non-array)', async () => {
      const results = await model.findMany({
        where: { AND: { age: { gte: 20 } } },
      });
      expect(results).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Compound unique key expansion
  // -------------------------------------------------------------------------
  describe('compound unique key expansion', () => {
    it('expands compound key into field-level match', async () => {
      await model.create({ data: { id: '1', scope: 'admin', key: 'dashboard' } });
      await model.create({ data: { id: '2', scope: 'user', key: 'profile' } });

      const found = await model.findUnique({
        where: { scope_key: { scope: 'admin', key: 'dashboard' } },
      });
      expect(found).not.toBeNull();
      expect((found as any).scope).toBe('admin');
    });

    it('returns null when compound key does not match', async () => {
      await model.create({ data: { id: '1', scope: 'admin', key: 'dashboard' } });

      const found = await model.findUnique({
        where: { scope_key: { scope: 'admin', key: 'settings' } },
      });
      expect(found).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------
  describe('orderBy', () => {
    beforeEach(async () => {
      await model.create({ data: { id: '1', age: 30, name: 'Charlie' } });
      await model.create({ data: { id: '2', age: 10, name: 'Alice' } });
      await model.create({ data: { id: '3', age: 20, name: 'Bob' } });
    });

    it('single field asc', async () => {
      const results = await model.findMany({ orderBy: { age: 'asc' } });
      expect(results.map((r: any) => r.name)).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('single field desc', async () => {
      const results = await model.findMany({ orderBy: { age: 'desc' } });
      expect(results.map((r: any) => r.name)).toEqual(['Charlie', 'Bob', 'Alice']);
    });

    it('multi-field sort', async () => {
      await model.create({ data: { id: '4', age: 20, name: 'Ava' } });
      const results = await model.findMany({
        orderBy: [{ age: 'asc' }, { name: 'asc' }],
      });
      expect(results.map((r: any) => r.name)).toEqual(['Alice', 'Ava', 'Bob', 'Charlie']);
    });
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------
  describe('skip / take', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 5; i++) {
        await model.create({ data: { id: String(i), seq: i } });
      }
    });

    it('skip', async () => {
      const results = await model.findMany({ orderBy: { seq: 'asc' }, skip: 2 });
      expect(results).toHaveLength(3);
      expect((results[0] as any).seq).toBe(3);
    });

    it('take', async () => {
      const results = await model.findMany({ orderBy: { seq: 'asc' }, take: 2 });
      expect(results).toHaveLength(2);
      expect((results[1] as any).seq).toBe(2);
    });

    it('skip + take', async () => {
      const results = await model.findMany({ orderBy: { seq: 'asc' }, skip: 1, take: 2 });
      expect(results).toHaveLength(2);
      expect(results.map((r: any) => r.seq)).toEqual([2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  // Aggregate
  // -------------------------------------------------------------------------
  describe('aggregate', () => {
    beforeEach(async () => {
      await model.create({ data: { id: '1', score: 10 } });
      await model.create({ data: { id: '2', score: 20 } });
      await model.create({ data: { id: '3', score: 30 } });
    });

    it('count (boolean mode)', async () => {
      const result = await model.aggregate!({ _count: true });
      expect(result._count).toBe(3);
    });

    it('count (object mode)', async () => {
      const result = await model.aggregate!({ _count: { _all: true } });
      expect((result._count as any)._all).toBe(3);
    });

    it('_sum', async () => {
      const result = await model.aggregate!({ _sum: { score: true } });
      expect((result._sum as any).score).toBe(60);
    });

    it('_avg', async () => {
      const result = await model.aggregate!({ _avg: { score: true } });
      expect((result._avg as any).score).toBe(20);
    });

    it('_min', async () => {
      const result = await model.aggregate!({ _min: { score: true } });
      expect((result._min as any).score).toBe(10);
    });

    it('_max', async () => {
      const result = await model.aggregate!({ _max: { score: true } });
      expect((result._max as any).score).toBe(30);
    });

    it('aggregate with where filter', async () => {
      const result = await model.aggregate!({
        where: { score: { gte: 20 } },
        _count: true,
        _sum: { score: true },
      });
      expect(result._count).toBe(2);
      expect((result._sum as any).score).toBe(50);
    });

    it('aggregate on empty set returns null for fields', async () => {
      const result = await model.aggregate!({
        where: { score: { gt: 100 } },
        _sum: { score: true },
        _min: { score: true },
        _max: { score: true },
      });
      expect((result._sum as any).score).toBeNull();
      expect((result._min as any).score).toBeNull();
      expect((result._max as any).score).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // createMany
  // -------------------------------------------------------------------------
  describe('createMany', () => {
    it('creates multiple records', async () => {
      const result = await model.createMany({
        data: [
          { id: '1', name: 'A' },
          { id: '2', name: 'B' },
        ],
      });
      expect(result.count).toBe(2);
      const all = await model.findMany();
      expect(all).toHaveLength(2);
    });

    it('skipDuplicates — skips records with existing ids', async () => {
      await model.create({ data: { id: '1', name: 'Original' } });
      const result = await model.createMany({
        data: [
          { id: '1', name: 'Duplicate' },
          { id: '2', name: 'New' },
        ],
        skipDuplicates: true,
      });
      expect(result.count).toBe(1);
      const original = await model.findUnique({ where: { id: '1' } });
      expect((original as any).name).toBe('Original');
    });
  });

  // -------------------------------------------------------------------------
  // updateMany / deleteMany
  // -------------------------------------------------------------------------
  describe('updateMany', () => {
    it('updates all matching records', async () => {
      await model.create({ data: { id: '1', status: 'draft' } });
      await model.create({ data: { id: '2', status: 'draft' } });
      await model.create({ data: { id: '3', status: 'published' } });

      const result = await model.updateMany({
        where: { status: 'draft' },
        data: { status: 'archived' },
      });
      expect(result.count).toBe(2);

      const archived = await model.findMany({ where: { status: 'archived' } });
      expect(archived).toHaveLength(2);
    });
  });

  describe('deleteMany', () => {
    it('deletes all matching records', async () => {
      await model.create({ data: { id: '1', status: 'old' } });
      await model.create({ data: { id: '2', status: 'old' } });
      await model.create({ data: { id: '3', status: 'new' } });

      const result = await model.deleteMany({ where: { status: 'old' } });
      expect(result.count).toBe(2);

      const remaining = await model.findMany();
      expect(remaining).toHaveLength(1);
    });

    it('deletes all when no where given', async () => {
      await model.create({ data: { id: '1' } });
      await model.create({ data: { id: '2' } });
      const result = await model.deleteMany();
      expect(result.count).toBe(2);
      expect(await model.findMany()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Transaction
  // -------------------------------------------------------------------------
  describe('$transaction', () => {
    it('executes function and returns result', async () => {
      const result = await adapter.$transaction(async (tx) => {
        const record = await tx.model('test').create({ data: { id: '1', name: 'TxTest' } });
        return record;
      });
      expect((result as any).name).toBe('TxTest');
      const found = await model.findUnique({ where: { id: '1' } });
      expect(found).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------
  describe('count', () => {
    it('returns count of matching records', async () => {
      await model.create({ data: { id: '1', status: 'active' } });
      await model.create({ data: { id: '2', status: 'active' } });
      await model.create({ data: { id: '3', status: 'inactive' } });

      expect(await model.count({ where: { status: 'active' } })).toBe(2);
      expect(await model.count()).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Model isolation
  // -------------------------------------------------------------------------
  describe('model isolation', () => {
    it('different models have independent stores', async () => {
      const users = adapter.model('users');
      const posts = adapter.model('posts');

      await users.create({ data: { id: '1', name: 'Alice' } });
      await posts.create({ data: { id: '1', title: 'Post 1' } });

      expect(await users.count()).toBe(1);
      expect(await posts.count()).toBe(1);

      await users.delete({ where: { id: '1' } });
      expect(await users.count()).toBe(0);
      expect(await posts.count()).toBe(1);
    });
  });
});
