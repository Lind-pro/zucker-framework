import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '../in-memory-adapter';
import { DynamicQueryParamService, DynamicQueryService, type DynamicQueryParam } from '../dynamic-query.service';
import { FilterOperatorFactory, EqualsOperator, IsNullOperator } from '../operators';
import { SoftDeleteService, type SoftDeletableEntity } from './soft-delete.service';

interface Item extends SoftDeletableEntity { name: string }
class Items extends SoftDeleteService<Item> {}

describe('soft-delete service isolation with real query execution', () => {
  let db: InMemoryAdapter;
  let service: Items;
  beforeEach(async () => {
    db = new InMemoryAdapter();
    const params = new DynamicQueryParamService(new FilterOperatorFactory([new EqualsOperator(), new IsNullOperator()]));
    service = new Items(db, new DynamicQueryService(db, params), 'items');
    await db.model('items').create({ data: { id: 'active', name: 'same', deletedAt: null } });
    await db.model('items').create({ data: { id: 'deleted', name: 'same', deletedAt: new Date(1000) } });
  });

  it.each<DynamicQueryParam>([
    { filters: '{"$or$name":"same"}' }, { filter: { name: 'same' } },
    { where: 'name = same' }, { terms: [{ column: 'name', termType: 'eq', value: 'same' }] },
    { filter: { deletedAt: new Date(1000) } },
  ])('cannot override trusted active condition with %j', async query => {
    const result = await service.findAll(query);
    expect(result.data.some(row => row.id === 'deleted')).toBe(false);
  });

  it('scopes inherited reads, counts, pager and chain queries', async () => {
    expect(await service.findByIdOptional('deleted')).toBeNull();
    expect((await service.findByIds(['active', 'deleted'])).map(row => row.id)).toEqual(['active']);
    expect(await service.count()).toBe(1);
    expect(await service.countByQuery({})).toBe(1);
    expect(await service.exists({ filter: { id: 'deleted' } })).toBe(false);
    expect((await service.queryPager({ page: 1, pageSize: 10 })).total).toBe(1);
    expect(await service.createQuery().count()).toBe(1);
    expect((await service.createQuery().fetch()).map(row => row.id)).toEqual(['active']);
  });

  it('scopes transaction callbacks without changing the shared adapter', async () => {
    await service.transaction(async tx => {
      expect(await tx.model('items').count()).toBe(1);
      expect(await tx.model('items').updateMany({ where: {}, data: { name: 'tx' } })).toEqual({ count: 1 });
    });
    expect(await db.model('items').count()).toBe(2);
  });

  it('blocks ordinary single, batch and save writes to retained rows', async () => {
    await expect(service.update('deleted', { name: 'changed' })).rejects.toThrow();
    await expect(service.save([{ id: 'deleted', name: 'changed' }])).rejects.toThrow();
    await expect(service.saveOrUpdate({ id: 'deleted', name: 'changed' })).rejects.toThrow();
    await expect(service.updateBatch([{ id: 'deleted', name: 'changed' }])).rejects.toThrow();
    expect(await service.updateMany({}, { name: 'changed' })).toEqual({ count: 1 });
    expect((await service.updateManyWithOptimisticLock([{ id: 'deleted', updatedAt: new Date(1), name: 'changed' }])).count).toBe(0);
    expect((await db.model('items').findUnique({ where: { id: 'deleted' } }) as Item).name).toBe('same');
  });

  it('blocks lifecycle field writes including event-free bulk methods', async () => {
    await expect(service.update('active', { deletedAt: null })).rejects.toThrow('Use delete() or restore()');
    await expect(service.createMany([{ id: 'new', deletedAt: new Date() }])).rejects.toThrow();
    await expect(service.createMany([{ id: 'deleted', name: 'overwrite' }])).rejects.toThrow();
    const created = await service.create({ name: 'new' });
    expect(await service.findByIdOptional(created.id)).toEqual(created);
  });

  it('soft deletes batches and keeps explicit recovery and physical deletion', async () => {
    expect(await service.deleteBatch(['active', 'deleted'])).toBe(1);
    expect(await service.count()).toBe(0);
    expect(await db.model('items').count()).toBe(2);
    expect((await service.findAll({}, { includeDeleted: true })).total).toBe(2);
    expect((await service.findAll({})).total).toBe(0);
    await service.restore('deleted');
    expect(await service.count()).toBe(1);
    await service.forceDelete('active');
    expect(await db.model('items').count()).toBe(1);
  });

  it('retains the active predicate when a row is deleted immediately before update', async () => {
    const raw = db.model('items');
    const originalModel = db.model.bind(db);
    let raced = false;
    vi.spyOn(db, 'model').mockImplementation(name => {
      const ops = originalModel(name);
      const update = ops.update.bind(ops);
      ops.update = async args => {
        if (!raced) {
          raced = true;
          await raw.update({ where: { id: 'active' }, data: { deletedAt: new Date() } });
        }
        return update(args);
      };
      return ops;
    });
    await expect(service.update('active', { name: 'changed' })).rejects.toThrow();
    expect((await raw.findUnique({ where: { id: 'active' } }) as Item).name).toBe('same');
  });
});
