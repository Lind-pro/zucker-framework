import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SoftDeleteService is an abstract NestJS @Injectable() class with decorator dependencies.
 * We test its core logic by creating a concrete subclass and mocking dependencies.
 */

// Mock NestJS decorators to avoid dependency issues
vi.mock('@nestjs/common', () => ({
  Injectable: () => (target: any) => target,
  NotFoundException: class NotFoundException extends Error {
    constructor(msg: string) { super(msg); this.name = 'NotFoundException'; }
  },
  Inject: () => () => {},
  Optional: () => () => {},
  Logger: class { log() {} error() {} warn() {} debug() {} verbose() {} },
}));

vi.mock('@zucker/event', () => ({
  EntityEventType: { CREATE: 'create', UPDATE: 'update', DELETE: 'delete' },
  EntityEventPhase: { BEFORE: 'before', AFTER: 'after', PREPARE: 'prepare' },
  TOPIC_EVENT_BUS: 'TOPIC_EVENT_BUS',
  createEntityEvent: vi.fn(),
  getEntityEventName: vi.fn().mockReturnValue('test-event'),
  isEntityEventEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../crud.module', () => ({
  DATABASE_ADAPTER: 'DATABASE_ADAPTER',
}));

// We need to import after mocks are set up
import { SoftDeleteService, type SoftDeletableEntity } from './soft-delete.service';
import { NotFoundException } from '@nestjs/common';

interface TestEntity extends SoftDeletableEntity {
  id: string;
  name: string;
  deletedAt?: Date | null;
}

function createMockDb() {
  return {
    model: vi.fn().mockReturnValue({
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      createMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    }),
    $transaction: vi.fn(),
  };
}

function createMockDynamicQuery() {
  return {
    buildQuery: vi.fn().mockReturnValue({}),
    buildPaginatedQuery: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 }),
    findMany: vi.fn().mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
      pageIndex: 0,
    }),
  };
}

// Concrete subclass for testing
class TestSoftDeleteService extends SoftDeleteService<TestEntity> {
  constructor(db: any, dynamicQuery: any) {
    super(db, dynamicQuery, 'testModel', undefined, undefined);
  }
}

describe('SoftDeleteService', () => {
  let db: ReturnType<typeof createMockDb>;
  let dynamicQuery: ReturnType<typeof createMockDynamicQuery>;
  let service: TestSoftDeleteService;

  beforeEach(() => {
    db = createMockDb();
    dynamicQuery = createMockDynamicQuery();
    service = new TestSoftDeleteService(db, dynamicQuery);
  });

  it('should find a non-deleted entity by id', async () => {
    const entity = { id: '1', name: 'Test', deletedAt: null };
    db.model('testModel').findUnique.mockResolvedValue(entity);
    const result = await service.findOne('1');
    expect(result).toEqual(entity);
  });

  it('should throw NotFoundException when entity not found', async () => {
    db.model('testModel').findUnique.mockResolvedValue(null);
    await expect(service.findOne('999')).rejects.toThrow(NotFoundException);
  });

  it('should throw NotFoundException for soft-deleted entity', async () => {
    const entity = { id: '1', name: 'Test', deletedAt: new Date() };
    db.model('testModel').findUnique.mockResolvedValue(entity);
    await expect(service.findOne('1')).rejects.toThrow(NotFoundException);
  });

  it('should soft delete by setting deletedAt', async () => {
    const entity = { id: '1', name: 'Test', deletedAt: null };
    db.model('testModel').findUnique.mockResolvedValue(entity);
    const updatedEntity = { ...entity, deletedAt: new Date() };
    db.model('testModel').update.mockResolvedValue(updatedEntity);

    const result = await service.delete('1');
    expect(result.deletedAt).not.toBeNull();
    expect(db.model('testModel').update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '1' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('should batch soft delete with updateMany', async () => {
    db.model('testModel').updateMany.mockResolvedValue({ count: 3 });
    const result = await service.deleteMany({ status: 'inactive' });
    expect(result.count).toBe(3);
    expect(db.model('testModel').updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('should restore a soft-deleted entity', async () => {
    const entity = { id: '1', name: 'Test', deletedAt: new Date() };
    db.model('testModel').findUnique.mockResolvedValue(entity);
    const restored = { ...entity, deletedAt: null };
    db.model('testModel').update.mockResolvedValue(restored);

    const result = await service.restore('1');
    expect(result.deletedAt).toBeNull();
    expect(db.model('testModel').update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '1' },
        data: { deletedAt: null },
      }),
    );
  });

  it('should throw NotFoundException when restoring non-existent entity', async () => {
    db.model('testModel').findUnique.mockResolvedValue(null);
    await expect(service.restore('999')).rejects.toThrow(NotFoundException);
  });

  it('should include deleted entities with includeDeleted option', async () => {
    const deletedEntity = { id: '1', name: 'Test', deletedAt: new Date() };
    db.model('testModel').findUnique.mockResolvedValue(deletedEntity);

    const result = await service.findOne('1', { includeDeleted: true });
    expect(result).toEqual(deletedEntity);
  });

  it('should inject soft delete filter in findAll', async () => {
    dynamicQuery.findMany = vi.fn().mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
      pageIndex: 0,
    });

    await service.findAll({ page: 1, pageSize: 20 });
    expect(dynamicQuery.findMany).toHaveBeenCalledWith(
      'testModel',
      expect.objectContaining({
        page: 1,
        pageSize: 20,
        filters: JSON.stringify({ 'deletedAt$isNull': true }),
      }),
      'createdAt',
    );
  });

  it('should add deletedAt null filter to deleteMany where clause', async () => {
    await service.deleteMany({ status: 'old' });
    const call = db.model('testModel').updateMany.mock.calls[0][0];
    expect(call.where).toHaveProperty('deletedAt', null);
  });

  it('should not add deletedAt filter when includeDeleted option is set for deleteMany', async () => {
    await service.deleteMany({ status: 'old' }, { includeDeleted: true });
    const call = db.model('testModel').updateMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('deletedAt');
  });

  it('should skip soft delete filter in findAll when includeDeleted is true', async () => {
    dynamicQuery.findMany = vi.fn().mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
      pageIndex: 0,
    });

    await service.findAll({ page: 1, pageSize: 20 }, { includeDeleted: true });
    expect(dynamicQuery.findMany).toHaveBeenCalledWith(
      'testModel',
      expect.objectContaining({
        page: 1,
        pageSize: 20,
      }),
      'createdAt',
    );
    // Should NOT have the deletedAt filter injected
    const callArgs = dynamicQuery.findMany.mock.calls[0][1];
    expect(callArgs.filters).toBeUndefined();
  });
});
