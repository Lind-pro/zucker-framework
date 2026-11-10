import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { InMemoryAdapter } from '../in-memory-adapter';
import { DynamicQueryParamService, DynamicQueryService } from '../dynamic-query.service';
import { FilterOperatorFactory, ALL_OPERATORS } from '../operators';
import { BaseService } from '../base.service';
import { SoftDeleteService, type SoftDeletableEntity } from './soft-delete.service';

interface Doc extends SoftDeletableEntity {
  id: string;
  name?: string;
  ownerId: string;
}

/** A soft-delete service restricted to one owner: `{ deletedAt: null, ownerId: 'me' }`. */
class OwnedDocs extends SoftDeleteService<Doc> {
  protected override get requiredQueryWhere() { return { deletedAt: null, ownerId: 'me' }; }
}

function dynamic(db: InMemoryAdapter) {
  return new DynamicQueryService(db, new DynamicQueryParamService(new FilterOperatorFactory(ALL_OPERATORS.map((Op) => new Op()))));
}

describe('SoftDeleteService keeps the subclass owner constraint on every path (N-M8)', () => {
  let db: InMemoryAdapter;
  let service: OwnedDocs;
  const at = new Date('2026-01-01T00:00:00Z');

  async function seed() {
    const row = (data: Partial<Doc>) =>
      db.model('docs').create({ data: { name: 'n', createdAt: at, updatedAt: at, deletedAt: null, ...data } });
    await row({ id: 'mine', ownerId: 'me' });
    await row({ id: 'mine-deleted', ownerId: 'me', deletedAt: new Date('2026-01-02T00:00:00Z') });
    await row({ id: 'theirs', ownerId: 'other' });
    await row({ id: 'theirs-deleted', ownerId: 'other', deletedAt: new Date('2026-01-02T00:00:00Z') });
  }
  const stored = (id: string) => db.model('docs').findUnique({ where: { id } }) as Promise<Doc | null>;

  beforeEach(async () => {
    db = new InMemoryAdapter();
    service = new OwnedDocs(db, dynamic(db), 'docs');
    await seed();
  });

  it('findOne returns own rows and hides another owner\'s, also with includeDeleted', async () => {
    await expect(service.findOne('mine')).resolves.toMatchObject({ id: 'mine' });
    await expect(service.findOne('theirs')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOne('theirs', { includeDeleted: true })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOne('theirs-deleted', { includeDeleted: true })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOne('mine-deleted', { includeDeleted: true })).resolves.toMatchObject({ id: 'mine-deleted' });
    await expect(service.findOne('mine-deleted')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete cannot soft-delete another owner\'s row', async () => {
    await expect(service.delete('theirs')).rejects.toBeInstanceOf(NotFoundException);
    expect((await stored('theirs'))?.deletedAt).toBeNull();
    await expect(service.delete('mine')).resolves.toMatchObject({ id: 'mine' });
    expect((await stored('mine'))?.deletedAt).toBeInstanceOf(Date);
  });

  it('restore cannot restore another owner\'s deleted row', async () => {
    await expect(service.restore('theirs-deleted')).rejects.toBeInstanceOf(NotFoundException);
    expect((await stored('theirs-deleted'))?.deletedAt).toBeInstanceOf(Date);
    await service.restore('mine-deleted');
    expect((await stored('mine-deleted'))?.deletedAt).toBeNull();
  });

  it('forceDelete cannot physically delete another owner\'s row', async () => {
    await expect(service.forceDelete('theirs')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.forceDelete('theirs-deleted')).rejects.toBeInstanceOf(NotFoundException);
    expect(await stored('theirs')).not.toBeNull();
    expect(await stored('theirs-deleted')).not.toBeNull();
    await service.forceDelete('mine');
    expect(await stored('mine')).toBeNull();
  });

  it('includeDeleted list reads exclude other owners but include own deleted rows', async () => {
    const ids = async (includeDeleted: boolean) =>
      ((await service.findAll({}, { includeDeleted })).data as Doc[]).map((row) => row.id).sort();
    expect(await ids(false)).toEqual(['mine']);
    expect(await ids(true)).toEqual(['mine', 'mine-deleted']);
  });

  it('deleteMany only touches the owner\'s rows', async () => {
    const result = await service.deleteMany({ name: 'n' });
    expect(result.count).toBe(1);
    expect((await stored('mine'))?.deletedAt).toBeInstanceOf(Date);
    expect((await stored('theirs'))?.deletedAt).toBeNull();
    await service.deleteMany({ name: 'n' }, { includeDeleted: true });
    expect((await stored('theirs'))?.deletedAt).toBeNull();
    expect((await stored('theirs-deleted'))?.deletedAt).toBeInstanceOf(Date);
  });

  it('updateManyWithOptimisticLock neither updates nor returns another owner\'s row', async () => {
    // BaseService (not soft-delete) with the same owner fence. The in-memory store cannot compare
    // Date versions, so every versioned update is reported as a conflict (count 0); the conflict
    // read that follows is what must be scoped to the owner.
    class ConflictingAdapter extends InMemoryAdapter {
      override model(name: string) {
        const ops = super.model(name);
        return new Proxy(ops, {
          get: (target, prop, receiver) =>
            prop === 'updateMany' ? async () => ({ count: 0 }) : Reflect.get(target, prop, receiver),
        });
      }
    }
    const conflicting = new ConflictingAdapter();
    for (const row of await db.model('docs').findMany({})) await conflicting.model('docs').create({ data: row as never });
    class OwnedBase extends BaseService<Doc> {
      protected override get requiredQueryWhere() { return { ownerId: 'me' }; }
    }
    const base = new OwnedBase(conflicting, dynamic(conflicting), 'docs');
    const result = await base.updateManyWithOptimisticLock([
      { id: 'theirs', updatedAt: new Date('2000-01-01T00:00:00Z'), name: 'hijack' },
      { id: 'mine', updatedAt: new Date('2000-01-01T00:00:00Z'), name: 'stale' },
    ]);
    expect(result.count).toBe(0);
    expect(result.failed.map((row) => row.id)).toEqual(['mine']);
  });
});
