import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { IsString, IsOptional } from 'class-validator';
import type { DatabaseAdapter, GenericEntity } from '@zucker-framework/core';
import { CrudService } from './base.service';
import { BaseController, type BaseControllerOptions } from './base.controller';
import { DynamicQueryParamService, DynamicQueryService } from './dynamic-query.service';
import { FilterOperatorFactory, ALL_OPERATORS } from './operators';
import { QueryParamDto } from './query/query-param.dto';
import { assertSafeBatchWhere, sanitizeWriteBody } from './write-policy';
import type { CrudQueryPolicy } from './query/query-policy';

interface Row extends GenericEntity { name?: string; role?: string }
class Entity { id!: string }

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
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const db = { model: vi.fn().mockReturnValue(modelOps), $transaction: vi.fn((fn) => fn(db)) } as unknown as DatabaseAdapter;
  return { db, modelOps };
}

const dynamic = (db: DatabaseAdapter) =>
  new DynamicQueryService(db, new DynamicQueryParamService(new FilterOperatorFactory(ALL_OPERATORS.map((Op) => new Op()))));

class RowService extends CrudService<Row> {}
class PolicyRowService extends CrudService<Row> {
  protected override get queryPolicy(): CrudQueryPolicy { return { deniedFields: ['role'] }; }
}

type Controller = Record<string, (...args: unknown[]) => Promise<unknown>>;
function controllerFor(service: unknown, options: BaseControllerOptions = {}): Controller {
  const Ctl = BaseController(Entity, options) as unknown as new (s: unknown) => Controller;
  return new Ctl(service);
}

/** Run a value through the pipe Nest would build for the given handler parameter. */
async function pipeArg(Ctl: { prototype: object }, method: string, index: number, value: unknown) {
  const metatypes = Reflect.getMetadata('design:paramtypes', Ctl.prototype, method) as unknown[] | undefined;
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Ctl.constructor === Function ? Ctl : Ctl, method) as
    Record<string, { index: number }> | undefined;
  const key = Object.keys(args ?? {}).find((candidate) => args![candidate].index === index) ?? '';
  const kind = key.startsWith('4:') ? 'query' : key.startsWith('5:') ? 'param' : 'body';
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  return pipe.transform(value, { type: kind, metatype: metatypes?.[index] as never });
}

afterEach(() => vi.restoreAllMocks());

describe('DTO write bodies (N-M5)', () => {
  class CreateDto {
    @IsString() name!: string;
    @IsOptional() @IsString() title?: string;
  }

  it('create accepts a transformed DTO instance and drops fields outside the DTO', async () => {
    const { db, modelOps } = mockDb();
    const Ctl = BaseController(Entity, { createDto: CreateDto, updateDto: CreateDto });
    const service = new RowService(db, dynamic(db), 'rows');
    const controller = new (Ctl as unknown as new (s: unknown) => Controller)(service);

    const body = await pipeArg(Ctl, 'create', 0, { name: 'a', role: 'admin', tenantId: 't1', creatorId: 'victim' });
    expect(body).toBeInstanceOf(CreateDto);
    expect(body).not.toHaveProperty('role');

    await expect(controller.create(body)).resolves.toMatchObject({ name: 'a' });
    expect(modelOps.create).toHaveBeenCalledWith({ data: { name: 'a' } });
  });

  it('update and saveOrUpdate also take DTO instances', async () => {
    const service = { update: vi.fn(async (_id, data) => data), saveOrUpdate: vi.fn(async (data) => data) };
    const Ctl = BaseController(Entity, { createDto: CreateDto, updateDto: CreateDto, only: ['update', 'saveOrUpdate'] });
    const controller = new (Ctl as unknown as new (s: unknown) => Controller)(service);
    const dto = Object.assign(new CreateDto(), { name: 'n', id: 'client-id' });
    await controller.update('id-1', dto);
    expect(service.update).toHaveBeenCalledWith('id-1', { name: 'n' });
    await controller.saveOrUpdate(dto);
    expect(service.saveOrUpdate).toHaveBeenCalledWith({ id: 'client-id', name: 'n' });
  });

  it('sanitizeWriteBody still rejects arrays, Dates, Maps, Buffers and primitives', () => {
    for (const bad of [[], new Date(), new Map(), new Set(), Buffer.from('a'), null, 'x', 1]) {
      expect(() => sanitizeWriteBody(bad)).toThrow(BadRequestException);
    }
  });

  it('a DTO instance goes through the same field rules as a plain body', () => {
    const dto = Object.assign(new CreateDto(), { name: 'n', creatorId: 'victim' });
    expect(sanitizeWriteBody(dto)).toEqual({ name: 'n' });
    expect(() => sanitizeWriteBody(Object.assign(new CreateDto(), { name: 'n', user: { update: { role: 'ADMIN' } } })))
      .toThrow(BadRequestException);
  });
});

describe('writePolicy.deniedFields (N-M5)', () => {
  it('rejects a denied field on every write route with 400', async () => {
    const service = {
      create: vi.fn(), createMany: vi.fn(), save: vi.fn(), update: vi.fn(), saveOrUpdate: vi.fn(),
    };
    const controller = controllerFor(service, {
      writePolicy: { deniedFields: ['role', 'tenantId'] },
      only: ['create', 'createMany', 'save', 'update', 'saveOrUpdate'],
    });
    await expect(controller.create({ name: 'a', role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.createMany([{ name: 'a', tenantId: 't' }])).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.save([{ name: 'a', role: 'admin' }])).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.update('id', { role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.saveOrUpdate({ role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
    expect(service.create).not.toHaveBeenCalled();

    await controller.create({ name: 'ok' });
    expect(service.create).toHaveBeenCalledWith({ name: 'ok' });
  });

  it('applies to sanitizeWriteBody directly, in create and update mode', () => {
    expect(() => sanitizeWriteBody({ role: 'x' }, { deniedFields: ['role'] }, 'update')).toThrow(/not writable/);
    expect(sanitizeWriteBody({ name: 'x' }, { deniedFields: ['role'] })).toEqual({ name: 'x' });
  });
});

describe('write route configuration warning (N-M5)', () => {
  const warned = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([message]) => String(message).includes('accept every non-audit scalar field'));

  it('warns when write routes have no writableFields, deniedFields or DTOs', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    BaseController(Entity);
    expect(warned(warn)).toHaveLength(1);
    expect(String(warned(warn)[0][0])).toContain('create');
  });

  it('does not warn when a write policy or DTO is configured', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    class Dto { @IsString() name!: string }
    BaseController(Entity, { writePolicy: { writableFields: ['name'] } });
    BaseController(Entity, { writePolicy: { deniedFields: ['role'] } });
    BaseController(Entity, { createDto: Dto });
    BaseController(Entity, { updateDto: Dto });
    expect(warned(warn)).toHaveLength(0);
  });

  it('does not warn when no write route is enabled', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    BaseController(Entity, { only: ['findOne', 'findAll'] });
    expect(warned(warn)).toHaveLength(0);
  });
});

describe('batch where hardening (N-L7)', () => {
  it('rejects empty contains / startsWith / endsWith patterns', () => {
    for (const op of ['contains', 'startsWith', 'endsWith']) {
      expect(() => assertSafeBatchWhere({ id: { [op]: '' } })).toThrow(BadRequestException);
      expect(() => assertSafeBatchWhere({ id: { [op]: 5 } })).toThrow(BadRequestException);
      expect(assertSafeBatchWhere({ name: { [op]: 'abc' } })).toEqual({ name: { [op]: 'abc' } });
    }
  });

  it('the generated batch routes reject an empty contains pattern before touching the service', async () => {
    const { db, modelOps } = mockDb();
    const controller = controllerFor(new RowService(db, dynamic(db), 'rows'), { only: ['updateMany', 'deleteMany'] });
    await expect(controller.deleteMany({ id: { contains: '' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.updateMany({ id: { contains: '' } }, { name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(modelOps.deleteMany).not.toHaveBeenCalled();
    expect(modelOps.updateMany).not.toHaveBeenCalled();
  });

  it('applies the service queryPolicy (denied fields) to the batch where', async () => {
    const { db, modelOps } = mockDb();
    const controller = controllerFor(new PolicyRowService(db, dynamic(db), 'rows'), { only: ['updateMany', 'deleteMany'] });
    await expect(controller.deleteMany({ role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.updateMany({ role: 'admin' }, { name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(modelOps.deleteMany).not.toHaveBeenCalled();
    await controller.deleteMany({ name: 'ok' });
    expect(modelOps.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('maxBatchRows rejects a batch matching more rows than the limit, and allows up to the limit', async () => {
    const { db, modelOps } = mockDb();
    const controller = controllerFor(new RowService(db, dynamic(db), 'rows'), { only: ['updateMany', 'deleteMany'], maxBatchRows: 5 });

    modelOps.count.mockResolvedValue(6);
    await expect(controller.deleteMany({ status: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.updateMany({ status: true }, { name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(modelOps.deleteMany).not.toHaveBeenCalled();
    expect(modelOps.updateMany).not.toHaveBeenCalled();

    modelOps.count.mockResolvedValue(5);
    await controller.deleteMany({ status: true });
    expect(modelOps.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('has no row limit by default and does not count', async () => {
    const { db, modelOps } = mockDb();
    const controller = controllerFor(new RowService(db, dynamic(db), 'rows'), { only: ['deleteMany'] });
    await controller.deleteMany({ status: true });
    expect(modelOps.count).not.toHaveBeenCalled();
    expect(modelOps.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('does not expose assertBatchSize as a route', () => {
    const Ctl = BaseController(Entity, { only: ['deleteMany'], maxBatchRows: 1 });
    expect(Reflect.getMetadata('path', Ctl.prototype.deleteMany)).toBe('batch');
    expect(Reflect.getMetadata('method', (Ctl.prototype as unknown as Record<string, unknown>).assertBatchSize ?? {})).toBeUndefined();
  });
});

describe('QueryParamDto through a whitelisting ValidationPipe (N-M7)', () => {
  const QUERY_ROUTES = ['findAll', 'queryNoPaging', 'queryNoPagingPost', 'queryPager', 'queryPagerPost', 'count', 'countPost', 'exists', 'existsPost'];
  const Ctl = BaseController(Entity, { queryDto: QueryParamDto });
  const terms = [{ column: 'name', termType: 'eq', value: 'a' }];

  for (const route of QUERY_ROUTES) {
    it(`${route} keeps filters, terms, filter, where and drops unknown properties`, async () => {
      const input = {
        filters: '{"name":"a"}', terms, filter: { name: 'a' }, where: "name = 'a'", orderBy: 'name asc',
        pageIndex: '0', total: '5', includes: 'id,name', evil: 'x',
      };
      const out = (await pipeArg(Ctl, route, 0, input)) as Record<string, unknown>;
      expect(out).toBeInstanceOf(QueryParamDto);
      expect(out.filters).toBe('{"name":"a"}');
      expect(out.terms).toEqual(terms);
      expect(out.filter).toEqual({ name: 'a' });
      expect(out.where).toBe("name = 'a'");
      expect(out.pageIndex).toBe(0);
      expect(out.includes).toEqual(['id', 'name']);
      expect(out).not.toHaveProperty('evil');
    });
  }

  it('accepts an object filters value (POST) and rejects other types', async () => {
    const out = (await pipeArg(Ctl, 'queryPagerPost', 0, { filters: { 'name$like': 'a' } })) as Record<string, unknown>;
    expect(out.filters).toEqual({ 'name$like': 'a' });
    await expect(pipeArg(Ctl, 'queryPagerPost', 0, { filters: 5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipeArg(Ctl, 'queryPagerPost', 0, { filters: ['a'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST _count with terms keeps the term in the generated where', async () => {
    const { db, modelOps } = mockDb();
    const controller = new (Ctl as unknown as new (s: unknown) => Controller)(new RowService(db, dynamic(db), 'rows'));
    const query = await pipeArg(Ctl, 'countPost', 0, { terms });
    await controller.countPost(query);
    const where = modelOps.count.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"name"');
    expect(JSON.stringify(where)).toContain('"a"');
  });

  it('POST _count with an object filters value applies the filter', async () => {
    const { db, modelOps } = mockDb();
    const controller = new (Ctl as unknown as new (s: unknown) => Controller)(new RowService(db, dynamic(db), 'rows'));
    const query = await pipeArg(Ctl, 'countPost', 0, { filters: { name: 'z' } });
    await controller.countPost(query);
    expect(JSON.stringify(modelOps.count.mock.calls[0][0].where)).toContain('"z"');
  });
});
