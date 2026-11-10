import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import {
  OperationCancelledException,
  ValidationException,
  Rules,
  type DatabaseAdapter,
  type GenericEntity,
  type TreeSortSupportEntity,
} from '@zucker-framework/core';
import { DefaultTopicEventBus, type TopicPayload } from '@zucker-framework/event';
import type { ICache } from '@zucker-framework/cache';
import { CrudService } from './base.service';
import { BaseController } from './base.controller';
import { CrudControllerFactory } from './crud.decorator';
import { DynamicQueryParamService, DynamicQueryService } from './dynamic-query.service';
import { FilterOperatorFactory, ALL_OPERATORS } from './operators';
import { InMemoryAdapter } from './in-memory-adapter';
import { TreeService } from './tree.service';
import { CacheEnabledService } from './services/cache-enabled.service';
import { CreatorEventListener } from './listeners/creator-event-listener';
import { SimpleEntityValidationRegistry, ValidateEventListener } from './listeners/validate-event-listener';
import { assertSafeBatchWhere, sanitizeWriteBody } from './write-policy';

interface Row extends GenericEntity {
  name?: string;
  tenantId?: string;
}

function params(operators = ALL_OPERATORS.map((Op) => new Op())) {
  return new DynamicQueryParamService(new FilterOperatorFactory(operators));
}

function mockDb() {
  const modelOps = {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn(async ({ data }) => ({ id: 'new', ...data })),
    update: vi.fn(async ({ data }) => ({ id: 'x', ...data })),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn(),
    createMany: vi.fn(),
  };
  const db = { model: vi.fn().mockReturnValue(modelOps), $transaction: vi.fn((fn) => fn(db)) } as unknown as DatabaseAdapter;
  return { db, modelOps };
}

class RowService extends CrudService<Row> {}

describe('H1 dynamic filters reject raw Prisma fragments', () => {
  const svc = params();

  it('rejects unknown operators instead of passing { field: value } through', () => {
    expect(() => svc.parseFilters({ OR$x: [{ passwordHash: { startsWith: '$2b' } }] })).toThrow(BadRequestException);
    expect(() => svc.parseFilters({ roles$x: { some: { code: 'admin' } } })).toThrow(BadRequestException);
    expect(() => new FilterOperatorFactory([]).applyFilter('a', 'nope', 1)).toThrow(BadRequestException);
  });

  it('rejects sensitive fields, logical keys, dotted paths and object values', () => {
    expect(() => svc.parseFilters({ passwordHash$startsWith: '$2b$10$a' })).toThrow(BadRequestException);
    expect(() => svc.parseFilters({ refreshToken: 'x' })).toThrow(BadRequestException);
    expect(() => svc.parseFilters({ AND$eq: 1 })).toThrow(BadRequestException);
    expect(() => svc.parseFilters({ roles$eq: { some: {} } })).toThrow(BadRequestException);
    expect(() => svc.userTermsToWhere([{ column: 'user.name', termType: 'eq', value: 'a' }])).toThrow(BadRequestException);
  });

  it('keeps ordinary scalar filters and built-in fallbacks for partial operator lists', () => {
    expect(params([]).parseFilters({ status: 'on', 'tags$in': ['a'] }, {})).toEqual({
      AND: [{ status: { equals: 'on' } }, { tags: { in: ['a'] } }],
    });
  });

  it('supports explicit opt-ins: allow-lists, allowedOperators and rawFilterFields', () => {
    expect(() => svc.parseFilters({ age$gt: 1 }, { filterableFields: ['name'] })).toThrow(BadRequestException);
    expect(() => svc.parseFilters({ name$like: 'a' }, { allowedOperators: ['eq'] })).toThrow(BadRequestException);
    expect(svc.parseFilters({ passwordHash$isNull: true }, { filterableFields: ['passwordHash'] }))
      .toEqual({ passwordHash: { equals: null } });
    expect(svc.parseFilters({ roles$x: { some: { id: 'r' } } }, { rawFilterFields: ['roles'] }))
      .toEqual({ roles: { some: { id: 'r' } } });
  });

  it('applies the policy to where expressions but not to trusted data-access terms', async () => {
    const { db, modelOps } = mockDb();
    const query = new DynamicQueryService(db, params());
    await expect(query.findMany('rows', { where: "password = 'x'" })).rejects.toBeInstanceOf(BadRequestException);
    await query.findMany('rows', {}, undefined, [{ column: 'ownerToken', termType: 'eq', value: 'o' }]);
    expect(modelOps.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerToken: { equals: 'o' } } }));
  });
});

describe('H2 / M2 / M3 projection, sorting and paging bounds', () => {
  it('rejects sensitive includes/orderBy and unknown shapes with 400', async () => {
    const { db } = mockDb();
    const query = new DynamicQueryService(db, params());
    await expect(query.findMany('rows', { includes: ['id', 'password'] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(query.findMany('rows', { orderBy: 'passwordHash asc' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(query.findMany('rows', { includes: ['id', 'user'] }, undefined, undefined, undefined, undefined,
      { policy: { selectableFields: ['id', 'name'] } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clamps pageSize, limits unpaged reads and coerces query-string numbers', async () => {
    const { db, modelOps } = mockDb();
    modelOps.count.mockResolvedValue(50_000);
    const query = new DynamicQueryService(db, params());
    const service = new RowService(db, query, 'rows');
    const page = await service.findAll({ page: 1, pageSize: 1_000_000 });
    expect(page.pageSize).toBe(1000);
    expect(modelOps.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1000 }));

    await service.findAll({});
    expect(modelOps.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 10_000 }));

    const result = await service.queryPager({ pageIndex: '1', pageSize: '10', includes: 'id,name' } as never);
    expect(result.page).toBe(2);
    expect(modelOps.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 10, select: { id: true, name: true } }));
  });
});

describe('H3 write bodies', () => {
  it('drops server-controlled audit fields, drops id on update and rejects nested writes', () => {
    expect(sanitizeWriteBody({ name: 'a', creatorId: 'victim', createdAt: '2020-01-01', deletedAt: null }))
      .toEqual({ name: 'a' });
    expect(sanitizeWriteBody({ id: 'other', name: 'a' }, {}, 'update')).toEqual({ name: 'a' });
    expect(() => sanitizeWriteBody({ user: { update: { role: 'ADMIN' } } })).toThrow(BadRequestException);
    expect(() => sanitizeWriteBody({ items: { deleteMany: {} } })).toThrow(BadRequestException);
    // JSON columns with permission-like keys stay writable.
    expect(sanitizeWriteBody({ features: { create: true, delete: false } })).toEqual({ features: { create: true, delete: false } });
    expect(() => sanitizeWriteBody({ name: 'a' }, { writableFields: ['title'] })).toThrow(BadRequestException);
    expect(sanitizeWriteBody({ creatorId: 'c' }, { serverControlledFields: [] })).toEqual({ creatorId: 'c' });
  });

  it('applies the policy in generated create routes', async () => {
    const Controller = BaseController(class Entity { id!: string });
    const service = { create: vi.fn(async (data) => data) };
    const controller = new (Controller as never as new (s: unknown) => { create(body: unknown): Promise<unknown> })(service);
    await controller.create({ name: 'a', creatorId: 'victim', createdAt: 'then' });
    expect(service.create).toHaveBeenCalledWith({ name: 'a' });
  });

  it('assigns the creator from the current user and never rewrites creators of existing rows (M6)', async () => {
    const bus = new DefaultTopicEventBus();
    new CreatorEventListener({ getCurrentUserId: () => 'me', getCurrentUserName: () => 'Me' }, bus);
    const created = { creatorId: 'victim', name: 'a' };
    await bus.publish('entity/rows/create/prepare', { phase: 'prepare', entity: created });
    expect(created.creatorId).toBe('me');
    const saved: Record<string, unknown> = { id: 'existing', name: 'b' };
    await bus.publish('entity/rows/save/prepare', { phase: 'prepare', entity: [saved] });
    expect(saved).not.toHaveProperty('creatorId');
    expect(saved).not.toHaveProperty('createdAt');
    expect(saved.modifierId).toBe('me');
    const update: Record<string, unknown> = { creatorId: 'victim', createdAt: new Date(0) };
    await bus.publish('entity/rows/modify/prepare', { phase: 'prepare', entity: update });
    expect(update).not.toHaveProperty('creatorId');
    expect(update).not.toHaveProperty('createdAt');
  });
});

describe('H4 batch routes', () => {
  it('declares static batch routes before :id and keeps them opt-in', () => {
    const Default = BaseController(class Entity { id!: string });
    expect(Reflect.get(Default.prototype, 'updateMany')).toBeUndefined();
    expect(Reflect.get(Default.prototype, 'deleteMany')).toBeUndefined();

    const Enabled = BaseController(class Entity { id!: string }, { only: ['update', 'delete', 'updateMany', 'deleteMany'] });
    const names = Object.getOwnPropertyNames(Enabled.prototype);
    expect(names.indexOf('updateMany')).toBeLessThan(names.indexOf('update'));
    expect(names.indexOf('deleteMany')).toBeLessThan(names.indexOf('delete'));
    expect(Reflect.getMetadata(PATH_METADATA, Enabled.prototype.deleteMany)).toBe('batch');
  });

  it('accepts only constrained scalar where clauses', () => {
    expect(() => assertSafeBatchWhere({})).toThrow(BadRequestException);
    expect(() => assertSafeBatchWhere({ id: { not: '' } })).toThrow(BadRequestException);
    expect(() => assertSafeBatchWhere({ OR: [{ id: 'a' }] })).toThrow(BadRequestException);
    expect(() => assertSafeBatchWhere({ roles: { some: {} } })).toThrow(BadRequestException);
    expect(() => assertSafeBatchWhere({ passwordHash: { startsWith: '$' } })).toThrow(BadRequestException);
    expect(() => assertSafeBatchWhere({ id: { in: [] } })).toThrow(BadRequestException);
    expect(assertSafeBatchWhere({ id: { in: ['a', 'b'] } })).toEqual({ id: { in: ['a', 'b'] } });
    expect(assertSafeBatchWhere({ status: true, id: { not: 'x' } })).toEqual({ status: true, id: { not: 'x' } });
  });

  it('ANDs the trusted constraint into service batch writes (M5)', async () => {
    const { db, modelOps } = mockDb();
    class Tenant extends RowService {
      protected override get requiredQueryWhere() { return { tenantId: 't1' }; }
    }
    const service = new Tenant(db, new DynamicQueryService(db, params()), 'rows');
    await service.deleteMany({ id: { in: ['a'] } });
    expect(modelOps.deleteMany).toHaveBeenCalledWith({ where: { AND: [{ id: { in: ['a'] } }, { tenantId: 't1' }] } });
    await service.findOne('a').catch(() => undefined);
    expect(modelOps.findUnique).toHaveBeenCalledWith({ where: { id: 'a', AND: [{ tenantId: 't1' }] } });
    await service.update('a', { name: 'n' });
    expect(modelOps.update).toHaveBeenCalledWith({ where: { id: 'a', AND: [{ tenantId: 't1' }] }, data: { name: 'n' } });
  });
});

describe('H5 entity validation is fail-closed', () => {
  function setup() {
    const db = new InMemoryAdapter();
    const bus = new DefaultTopicEventBus();
    const registry = new SimpleEntityValidationRegistry();
    registry.registerSchema('rows', 'create', { name: [Rules.required('name required')] });
    new ValidateEventListener(registry, bus);
    const service = new RowService(db, new DynamicQueryService(db, params()), 'rows', bus);
    return { db, bus, service };
  }

  it('rejects an invalid create and does not write', async () => {
    const { db, service } = setup();
    await expect(service.create({ id: 'r1' })).rejects.toBeInstanceOf(ValidationException);
    expect(await db.model('rows').findUnique({ where: { id: 'r1' } })).toBeNull();
  });

  it('keeps fire-and-forget subscribers isolated', async () => {
    const { bus, service } = setup();
    bus.subscribe('entity/rows/create/after', () => {
      throw new Error('audit sink down');
    });
    await expect(service.create({ id: 'r2', name: 'ok' })).resolves.toMatchObject({ id: 'r2' });
  });

  it('honours cancel() from the PREPARE phase', async () => {
    const { bus, service } = setup();
    bus.subscribe('entity/rows/create/prepare', (msg: TopicPayload) => (msg.payload as { cancel(r: string): void }).cancel('no'));
    await expect(service.create({ id: 'r3', name: 'x' })).rejects.toBeInstanceOf(OperationCancelledException);
  });
});

describe('M7 tree reparenting through update', () => {
  interface Node extends TreeSortSupportEntity { id: string; name?: string }
  class Nodes extends TreeService<Node> {}

  it('recomputes path for the subtree and keeps cascade deletes correct', async () => {
    const db = new InMemoryAdapter();
    const nodes = new Nodes(db, new DynamicQueryService(db, params()), 'node');
    const now = new Date();
    for (const n of [
      { id: 'A', parentId: null, path: 'A', level: 0 },
      { id: 'B', parentId: null, path: 'B', level: 0 },
      { id: 'C', parentId: 'A', path: 'A/C', level: 1 },
      { id: 'D', parentId: 'C', path: 'A/C/D', level: 2 },
    ]) await db.model('node').create({ data: { ...n, createdAt: now, updatedAt: now } });

    await nodes.update('C', { parentId: 'B', path: 'forged' } as Partial<Node>);
    expect((await nodes.findOne('C')).path).toBe('B/C');
    expect((await nodes.findOne('D')).path).toBe('B/C/D');

    await nodes.delete('A');
    expect(await nodes.findByIdOptional('C')).not.toBeNull();
    await expect(nodes.update('B', { parentId: 'D' } as Partial<Node>)).rejects.toBeInstanceOf(ValidationException);
  });
});

describe('M8 / M9 CacheEnabledService', () => {
  function memoryCache(): ICache & { store: Map<string, unknown> } {
    const store = new Map<string, unknown>();
    return {
      store,
      get: async (k: string) => store.get(k) as never,
      set: async (k: string, v: unknown) => void store.set(k, v),
      del: async (k: string) => void store.delete(k),
    } as never;
  }
  class Cached extends CacheEnabledService<Row> {}

  it('separates the all-key from ids and evicts per-ID entries on batch writes', async () => {
    const db = new InMemoryAdapter();
    const cache = memoryCache();
    const service = new Cached(db, new DynamicQueryService(db, params()), 'rows', cache);
    const now = new Date();
    await db.model('rows').create({ data: { id: 'a', name: 'old', createdAt: now, updatedAt: now } });
    await service.getCacheAll();
    await expect(service.findOne('@all')).rejects.toThrow();
    expect((await service.findOne('a')).name).toBe('old');
    await service.updateMany({ id: 'a' }, { name: 'new' });
    expect((await service.findOne('a')).name).toBe('new');
    await service.save([{ id: 'a', name: 'saved' }]);
    expect((await service.findOne('a')).name).toBe('saved');
  });
});

describe('M12 CrudService.transaction propagates to other services', () => {
  it('runs CRUD methods of services sharing the adapter on the transaction client', async () => {
    const root = mockDb();
    const tx = mockDb();
    (root.db as { $transaction: unknown }).$transaction = vi.fn(async (fn: (a: DatabaseAdapter) => unknown) => fn(tx.db));
    const query = new DynamicQueryService(root.db, params());
    const a = new RowService(root.db, query, 'a');
    const b = new RowService(root.db, query, 'b');
    await a.transaction(async () => {
      await a.create({ name: 'x' });
      await b.update('id', { name: 'y' });
    });
    expect(tx.modelOps.create).toHaveBeenCalled();
    expect(tx.modelOps.update).toHaveBeenCalled();
    expect(root.modelOps.create).not.toHaveBeenCalled();
    await a.create({ name: 'outside' });
    expect(root.modelOps.create).toHaveBeenCalledTimes(1);
  });
});

describe('L1 CrudControllerFactory', () => {
  it('registers parameter metadata and route decorators for every route', () => {
    const marker = vi.fn();
    const Controller = CrudControllerFactory(class S {} as never, {
      routes: { update: { decorators: [marker as MethodDecorator] } },
    });
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Controller, 'update');
    expect(Object.keys(args ?? {})).toHaveLength(2);
    expect(marker).toHaveBeenCalled();
    expect(Reflect.getMetadata(METHOD_METADATA, (Controller.prototype as unknown as Record<string, object>).update)).toBeDefined();
  });
});
