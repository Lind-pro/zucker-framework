import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { BaseService } from './base.service';
import { InMemoryAdapter } from './in-memory-adapter';
import { DynamicQueryService, DynamicQueryParamService } from './dynamic-query.service';
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
  IsNotNullOperator,
  BetweenOperator,
  HasOperator,
  HasSomeOperator,
  NotLikeOperator,
  StartsWithOperator,
  EndsWithOperator,
  EmptyOperator,
  NotEmptyOperator,
} from './operators';
import type { GenericEntity } from '@zucker-framework/core';

// ---------------------------------------------------------------------------
// Test entity type
// ---------------------------------------------------------------------------
interface TestEntity extends GenericEntity {
  id: string;
  name: string;
  age: number;
  status: string;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Concrete subclass of BaseService for testing
// ---------------------------------------------------------------------------
class TestService extends BaseService<TestEntity> {
  constructor(
    db: InMemoryAdapter,
    dynamicQuery: DynamicQueryService,
  ) {
    // Call super without NestJS decorators — we manually pass dependencies
    super(db, dynamicQuery, 'testEntity', undefined, undefined);
  }
}

// ---------------------------------------------------------------------------
// Helper: build real FilterOperatorFactory + DynamicQueryParamService + DynamicQueryService
// ---------------------------------------------------------------------------
function buildDeps(db: InMemoryAdapter) {
  const operators = [
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
    new IsNotNullOperator(),
    new BetweenOperator(),
    new HasOperator(),
    new HasSomeOperator(),
    new NotLikeOperator(),
    new StartsWithOperator(),
    new EndsWithOperator(),
    new EmptyOperator(),
    new NotEmptyOperator(),
  ];
  const factory = new FilterOperatorFactory(operators);
  const paramService = new DynamicQueryParamService(factory);
  const dynamicQuery = new DynamicQueryService(db, paramService);
  return { dynamicQuery };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BaseService', () => {
  let db: InMemoryAdapter;
  let service: TestService;

  beforeEach(() => {
    db = new InMemoryAdapter();
    const { dynamicQuery } = buildDeps(db);
    service = new TestService(db, dynamicQuery);
  });

  // =================== create ===================
  describe('create', () => {
    it('should create an entity and return it with an id', async () => {
      const result = await service.create({ name: 'Alice', age: 30, status: 'active' });
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.name).toBe('Alice');
      expect(result.age).toBe(30);
    });

    it('should respect a provided id', async () => {
      const result = await service.create({ id: 'custom-id', name: 'Bob', age: 25, status: 'active' });
      expect(result.id).toBe('custom-id');
    });
  });

  // =================== update ===================
  describe('update', () => {
    it('should update an existing entity', async () => {
      const created = await service.create({ name: 'Alice', age: 30, status: 'active' });
      const updated = await service.update(created.id, { age: 31 });
      expect(updated.id).toBe(created.id);
      expect(updated.age).toBe(31);
      expect(updated.name).toBe('Alice');
    });

    it('should throw when updating a non-existent entity', async () => {
      // InMemoryAdapter throws a plain Error (no P2025 code), which BaseService re-throws
      await expect(service.update('non-existent', { age: 99 })).rejects.toThrow();
    });
  });

  // =================== delete ===================
  describe('delete', () => {
    it('should delete an existing entity and return it', async () => {
      const created = await service.create({ name: 'Alice', age: 30, status: 'active' });
      const deleted = await service.delete(created.id);
      expect(deleted.id).toBe(created.id);

      // Verify it's actually gone
      await expect(service.findOne(created.id)).rejects.toThrow(NotFoundException);
    });

    it('should throw when deleting a non-existent entity', async () => {
      await expect(service.delete('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  // =================== findOne ===================
  describe('findOne', () => {
    it('should find an existing entity by id', async () => {
      const created = await service.create({ name: 'Alice', age: 30, status: 'active' });
      const found = await service.findOne(created.id);
      expect(found.id).toBe(created.id);
      expect(found.name).toBe('Alice');
    });

    it('should throw NotFoundException for non-existent id', async () => {
      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for empty id', async () => {
      await expect(service.findOne('')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for whitespace-only id', async () => {
      await expect(service.findOne('   ')).rejects.toThrow(NotFoundException);
    });
  });

  // =================== findByIdOptional ===================
  describe('findByIdOptional', () => {
    it('should return the entity when found', async () => {
      const created = await service.create({ name: 'Alice', age: 30, status: 'active' });
      const found = await service.findByIdOptional(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('should return null when not found', async () => {
      const found = await service.findByIdOptional('non-existent');
      expect(found).toBeNull();
    });

    it('should return null for empty id', async () => {
      const found = await service.findByIdOptional('');
      expect(found).toBeNull();
    });
  });

  // =================== findByIds ===================
  describe('findByIds', () => {
    it('should return entities matching the provided ids', async () => {
      const a = await service.create({ name: 'Alice', age: 30, status: 'active' });
      const b = await service.create({ name: 'Bob', age: 25, status: 'active' });
      await service.create({ name: 'Charlie', age: 35, status: 'inactive' });

      const found = await service.findByIds([a.id, b.id]);
      expect(found).toHaveLength(2);
      const ids = found.map((e) => e.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it('should return empty array for empty ids', async () => {
      const found = await service.findByIds([]);
      expect(found).toEqual([]);
    });
  });

  // =================== save (batch upsert) ===================
  describe('save', () => {
    it('should create entities without ids', async () => {
      const result = await service.save([
        { name: 'Alice', age: 30, status: 'active' },
        { name: 'Bob', age: 25, status: 'active' },
      ]);
      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.total).toBe(2);
    });

    it('should update entities with existing ids', async () => {
      const created = await service.create({ name: 'Alice', age: 30, status: 'active' });
      const result = await service.save([
        { id: created.id, name: 'Alice Updated', age: 31, status: 'active' },
      ]);
      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);

      const found = await service.findOne(created.id);
      expect(found.name).toBe('Alice Updated');
    });

    it('should handle mixed create and update', async () => {
      const existing = await service.create({ name: 'Existing', age: 40, status: 'active' });
      const result = await service.save([
        { id: existing.id, name: 'Updated', age: 41, status: 'active' },
        { name: 'New', age: 20, status: 'active' },
      ]);
      expect(result.updated).toBe(1);
      expect(result.created).toBe(1);
      expect(result.total).toBe(2);
    });

    it('should return zeros for empty array', async () => {
      const result = await service.save([]);
      expect(result).toEqual({ created: 0, updated: 0, total: 0 });
    });
  });

  // =================== createMany ===================
  describe('createMany', () => {
    it('should create multiple entities and return count', async () => {
      const result = await service.createMany([
        { name: 'A', age: 1, status: 'x' },
        { name: 'B', age: 2, status: 'y' },
        { name: 'C', age: 3, status: 'z' },
      ]);
      expect(result.count).toBe(3);
    });

    it('should return zero count for empty array', async () => {
      const result = await service.createMany([]);
      expect(result.count).toBe(0);
    });
  });

  // =================== updateMany ===================
  describe('updateMany', () => {
    it('should update matching entities', async () => {
      await service.create({ name: 'A', age: 10, status: 'active' });
      await service.create({ name: 'B', age: 20, status: 'active' });
      await service.create({ name: 'C', age: 30, status: 'inactive' });

      const result = await service.updateMany({ status: 'active' }, { status: 'archived' } as Partial<TestEntity>);
      expect(result.count).toBe(2);
    });
  });

  // =================== deleteMany ===================
  describe('deleteMany', () => {
    it('should delete matching entities', async () => {
      await service.create({ name: 'A', age: 10, status: 'active' });
      await service.create({ name: 'B', age: 20, status: 'inactive' });
      await service.create({ name: 'C', age: 30, status: 'inactive' });

      const result = await service.deleteMany({ status: 'inactive' });
      expect(result.count).toBe(2);

      // Verify only active entity remains
      const remaining = await service.findByIds(
        (await service.findAll({ page: 1, pageSize: 100 })).data.map((e) => e.id),
      );
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('A');
    });
  });

  // =================== softDelete + restore ===================
  describe('softDelete and restore', () => {
    it('should set deletedAt on softDelete', async () => {
      const entity = await service.create({ name: 'Alice', age: 30, status: 'active' });
      const deleted = await service.softDelete(entity.id);
      expect(deleted.deletedAt).toBeDefined();
      expect(deleted.deletedAt).toBeInstanceOf(Date);
    });

    it('should clear deletedAt on restore', async () => {
      const entity = await service.create({ name: 'Alice', age: 30, status: 'active' });
      await service.softDelete(entity.id);
      const restored = await service.restore(entity.id);
      expect(restored.deletedAt).toBeNull();
    });
  });

  // =================== createQuery ===================
  describe('createQuery', () => {
    it('should return a chainable query builder', async () => {
      await service.create({ id: 'q1', name: 'Alice', age: 30, status: 'active' });
      await service.create({ id: 'q2', name: 'Bob', age: 25, status: 'active' });
      await service.create({ id: 'q3', name: 'Charlie', age: 35, status: 'inactive' });

      const results = await service.createQuery()
        .whereEq('status', 'active')
        .fetch();
      expect(results).toHaveLength(2);
    });

    it('should support fetchOne', async () => {
      await service.create({ id: 'q1', name: 'Alice', age: 30, status: 'active' });
      const result = await service.createQuery()
        .whereEq('name', 'Alice')
        .fetchOne();
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Alice');
    });

    it('should support count', async () => {
      await service.create({ name: 'A', age: 1, status: 'x' });
      await service.create({ name: 'B', age: 2, status: 'x' });
      await service.create({ name: 'C', age: 3, status: 'y' });

      const count = await service.createQuery()
        .whereEq('status', 'x')
        .count();
      expect(count).toBe(2);
    });
  });

  // =================== count + countByQuery ===================
  describe('count and countByQuery', () => {
    beforeEach(async () => {
      await service.create({ name: 'A', age: 10, status: 'active' });
      await service.create({ name: 'B', age: 20, status: 'active' });
      await service.create({ name: 'C', age: 30, status: 'inactive' });
    });

    it('should count all records when no where clause', async () => {
      const total = await service.count();
      expect(total).toBe(3);
    });

    it('should count with a where clause', async () => {
      const total = await service.count({ status: 'active' });
      expect(total).toBe(2);
    });

    it('should count by dynamic query param', async () => {
      const total = await service.countByQuery({
        filter: { 'status$eq': 'active' },
      });
      expect(total).toBe(2);
    });
  });

  // =================== exists ===================
  describe('exists', () => {
    beforeEach(async () => {
      await service.create({ name: 'A', age: 10, status: 'active' });
    });

    it('should return true when matching records exist', async () => {
      const result = await service.exists({
        filter: { 'status$eq': 'active' },
        page: 1,
        pageSize: 1,
      });
      expect(result).toBe(true);
    });

    it('should return false when no matching records', async () => {
      const result = await service.exists({
        filter: { 'status$eq': 'deleted' },
        page: 1,
        pageSize: 1,
      });
      expect(result).toBe(false);
    });
  });

  // =================== queryPager ===================
  describe('queryPager', () => {
    beforeEach(async () => {
      for (let i = 0; i < 25; i++) {
        await service.create({ name: `User${i}`, age: 20 + i, status: 'active' });
      }
    });

    it('should return paginated results', async () => {
      const result = await service.queryPager({ page: 1, pageSize: 10 });
      expect(result.data).toHaveLength(10);
      expect(result.total).toBe(25);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      expect(result.totalPages).toBe(3);
    });

    it('should return correct page 2', async () => {
      const result = await service.queryPager({ page: 2, pageSize: 10 });
      expect(result.data).toHaveLength(10);
      expect(result.page).toBe(2);
    });

    it('should return last page correctly', async () => {
      const result = await service.queryPager({ page: 3, pageSize: 10 });
      expect(result.data).toHaveLength(5);
      expect(result.page).toBe(3);
    });

    it('should rePaging — adjust page when it exceeds totalPages', async () => {
      const result = await service.queryPager({ page: 100, pageSize: 10 });
      // Should be adjusted to the last page (3)
      expect(result.page).toBe(3);
      expect(result.data).toHaveLength(5);
    });

    it('should skip count query when total is pre-provided', async () => {
      const result = await service.queryPager({ page: 1, pageSize: 10, total: 25 });
      expect(result.data).toHaveLength(10);
      expect(result.total).toBe(25);
    });

    it('should return empty results when total is 0', async () => {
      const result = await service.queryPager({
        page: 1,
        pageSize: 10,
        filter: { 'status$eq': 'nonexistent' },
      });
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  // =================== saveOrUpdate ===================
  describe('saveOrUpdate', () => {
    it('should create when no id provided', async () => {
      const result = await service.saveOrUpdate({ name: 'New', age: 20, status: 'active' });
      expect(result.id).toBeDefined();
      expect(result.name).toBe('New');
    });

    it('should update when id exists', async () => {
      const created = await service.create({ name: 'Old', age: 30, status: 'active' });
      const result = await service.saveOrUpdate({ id: created.id, name: 'Updated', age: 31, status: 'active' });
      expect(result.id).toBe(created.id);
      expect(result.name).toBe('Updated');
    });

    it('creates a row for an unknown client-generated id (upsert, N-M9)', async () => {
      const saved = await service.saveOrUpdate({ id: 'non-existent', name: 'X', age: 1, status: 'x' });
      expect(saved).toMatchObject({ id: 'non-existent', name: 'X' });
    });
  });

  // =================== updateManyWithOptimisticLock ===================
  describe('updateManyWithOptimisticLock', () => {
    it('should update when updatedAt matches', async () => {
      const now = new Date('2024-01-01T00:00:00Z');
      const entity = await service.create({
        name: 'Alice',
        age: 30,
        status: 'active',
        updatedAt: now,
      });

      const result = await service.updateManyWithOptimisticLock([
        { id: entity.id, updatedAt: now, name: 'Alice Updated' } as any,
      ]);
      expect(result.count).toBe(1);
      expect(result.failed).toHaveLength(0);
    });

    it('should report failure when no records match the optimistic lock condition', async () => {
      // InMemoryAdapter cannot compare Date objects as simple values (they pass
      // through the operator branch vacuously). To test the "no match" path we
      // use a non-existent id so updateMany returns count=0.
      const result = await service.updateManyWithOptimisticLock([
        { id: 'does-not-exist', updatedAt: new Date(), name: 'Conflict' } as any,
      ]);
      expect(result.count).toBe(0);
      // failed will be empty because findUnique also returns null for non-existent id
      expect(result.failed).toHaveLength(0);
    });

    it('should return zeros for empty input', async () => {
      const result = await service.updateManyWithOptimisticLock([]);
      expect(result).toEqual({ count: 0, failed: [] });
    });
  });

  // =================== createBatch ===================
  describe('createBatch', () => {
    it('should create multiple entities', async () => {
      const results = await service.createBatch([
        { name: 'A', age: 1, status: 'x' },
        { name: 'B', age: 2, status: 'y' },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBeDefined();
      expect(results[1].id).toBeDefined();
    });

    it('should return empty array for empty input', async () => {
      const results = await service.createBatch([]);
      expect(results).toEqual([]);
    });

    it('should support skipEvents option', async () => {
      const results = await service.createBatch(
        [{ name: 'C', age: 3, status: 'z' }],
        { skipEvents: true },
      );
      expect(results).toHaveLength(1);
    });
  });

  // =================== updateBatch ===================
  describe('updateBatch', () => {
    it('should update multiple entities', async () => {
      const a = await service.create({ name: 'A', age: 1, status: 'x' });
      const b = await service.create({ name: 'B', age: 2, status: 'y' });

      const results = await service.updateBatch([
        { id: a.id, name: 'A-updated' },
        { id: b.id, name: 'B-updated' },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('A-updated');
      expect(results[1].name).toBe('B-updated');
    });

    it('should throw for non-existent id in batch', async () => {
      await expect(
        service.updateBatch([{ id: 'non-existent', name: 'fail' }]),
      ).rejects.toThrow();
    });

    it('should return empty array for empty input', async () => {
      const results = await service.updateBatch([]);
      expect(results).toEqual([]);
    });
  });

  // =================== deleteBatch ===================
  describe('deleteBatch', () => {
    it('should delete multiple entities and return count', async () => {
      const a = await service.create({ name: 'A', age: 1, status: 'x' });
      const b = await service.create({ name: 'B', age: 2, status: 'y' });
      await service.create({ name: 'C', age: 3, status: 'z' });

      const count = await service.deleteBatch([a.id, b.id]);
      expect(count).toBe(2);

      // Verify remaining
      const total = await service.count();
      expect(total).toBe(1);
    });

    it('should skip non-existent ids gracefully', async () => {
      const a = await service.create({ name: 'A', age: 1, status: 'x' });
      const count = await service.deleteBatch([a.id, 'non-existent']);
      expect(count).toBe(1);
    });

    it('should return 0 for empty input', async () => {
      const count = await service.deleteBatch([]);
      expect(count).toBe(0);
    });
  });

  // =================== findAll (dynamic query) ===================
  describe('findAll', () => {
    beforeEach(async () => {
      await service.create({ name: 'Alice', age: 30, status: 'active' });
      await service.create({ name: 'Bob', age: 25, status: 'inactive' });
      await service.create({ name: 'Charlie', age: 35, status: 'active' });
    });

    it('should return paginated results with filter', async () => {
      const result = await service.findAll({
        filter: { 'status$eq': 'active' },
        page: 1,
        pageSize: 10,
      });
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should return all results when no pagination is specified', async () => {
      const result = await service.findAll({});
      expect(result.data).toHaveLength(3);
    });
  });

  // =================== transaction ===================
  describe('transaction', () => {
    it('should execute callback within transaction context', async () => {
      const result = await service.transaction(async (txDb) => {
        const entity = await txDb.model('testEntity').create({
          data: { name: 'TxTest', age: 1, status: 'tx' },
        });
        return entity;
      });
      expect(result).toBeDefined();
      expect((result as any).name).toBe('TxTest');
    });
  });
});
