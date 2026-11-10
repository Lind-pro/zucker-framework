import { describe, expect, it } from 'vitest';
import { DefaultTopicEventBus } from '@zucker-framework/event';
import type { GenericEntity } from '@zucker-framework/core';
import { CrudService } from '../base.service';
import { InMemoryAdapter } from '../in-memory-adapter';
import { DynamicQueryParamService, DynamicQueryService } from '../dynamic-query.service';
import { FilterOperatorFactory, ALL_OPERATORS } from '../operators';
import { CreatorEventListener } from './creator-event-listener';

interface Row extends GenericEntity { name?: string; creatorId?: string; modifierId?: string }
class RowService extends CrudService<Row> {}

function setup() {
  const db = new InMemoryAdapter();
  const bus = new DefaultTopicEventBus();
  new CreatorEventListener({ getCurrentUserId: () => 'me', getCurrentUserName: () => 'Me' }, bus);
  const query = new DynamicQueryService(db, new DynamicQueryParamService(new FilterOperatorFactory(ALL_OPERATORS.map((Op) => new Op()))));
  const service = new RowService(db, query, 'rows', bus);
  const at = new Date('2026-01-01T00:00:00Z');
  const seedExisting = () => db.model('rows').create({ data: { id: 'existing', name: 'old', creatorId: 'orig', createdAt: at, updatedAt: at } });
  const stored = (id: string) => db.model('rows').findUnique({ where: { id } }) as Promise<Row | null>;
  return { service, seedExisting, stored };
}

describe('save / saveOrUpdate mark new rows before PREPARE (N-M9)', () => {
  it('save sets creator fields only on the row that does not exist yet', async () => {
    const { service, seedExisting, stored } = setup();
    await seedExisting();

    const result = await service.save([{ id: 'new', name: 'n' }, { id: 'existing', name: 'changed' }]);
    expect(result).toMatchObject({ created: 1, updated: 1, total: 2 });

    expect(await stored('new')).toMatchObject({ creatorId: 'me', name: 'n' });
    expect((await stored('new'))?.createdAt).toBeInstanceOf(Date);
    const existing = await stored('existing');
    expect(existing).toMatchObject({ name: 'changed', creatorId: 'orig', modifierId: 'me' });
  });

  it('save keeps treating rows without an id as creates', async () => {
    const { service } = setup();
    const result = await service.save([{ name: 'anonymous' }]);
    expect(result.created).toBe(1);
  });

  it('saveOrUpdate with an unknown id creates the row and sets the creator', async () => {
    const { service, stored } = setup();
    const saved = await service.saveOrUpdate({ id: 'brand-new', name: 'n' });
    expect(saved).toMatchObject({ id: 'brand-new', creatorId: 'me' });
    expect(await stored('brand-new')).toMatchObject({ creatorId: 'me' });
  });

  it('saveOrUpdate on an existing id updates it and does not rewrite the creator', async () => {
    const { service, seedExisting, stored } = setup();
    await seedExisting();
    await service.saveOrUpdate({ id: 'existing', name: 'changed', creatorId: 'victim' } as Partial<Row>);
    expect(await stored('existing')).toMatchObject({ name: 'changed', creatorId: 'orig', modifierId: 'me' });
  });

  it('the marker does not leak into persisted data', async () => {
    const { service, stored } = setup();
    await service.save([{ id: 'x', name: 'n' }]);
    const row = (await stored('x')) as unknown as Record<string | symbol, unknown>;
    expect(Object.getOwnPropertySymbols(row)).toEqual([]);
  });
});
