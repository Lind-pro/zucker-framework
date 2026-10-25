import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DictionaryItemService, DictionaryService } from '@zucker-framework/dictionary';
import { dictionaryFixture } from './helpers/dictionary-fixture';
const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('default dictionary manager with real PostgreSQL and administrator HTTP', () => {
  let f: Awaited<ReturnType<typeof dictionaryFixture>>, reader: { token: string }, creator: { token: string };
  const post = (path: string, body: object, token = f.admin.token) => request(f.app.getHttpServer()).post(`/api/${path}`).set('Authorization', `Bearer ${token}`).send(body);
  const put = (path: string, body: object, token = f.admin.token) => request(f.app.getHttpServer()).put(`/api/${path}`).set('Authorization', `Bearer ${token}`).send(body);
  const createDictionary = async (name: string) => (await post('dictionary', { name, classified: name, describe: 'Synthetic dictionary' }).expect(201)).body as { id: string; name: string };
  beforeAll(async () => { f = await dictionaryFixture(process.env.TEST_DATABASE_URL!); reader = await f.member('dictreader', ['dictionary:query']); creator = await f.member('dictcreator', ['dictionary:query', 'dictionary:add']); });
  afterAll(async () => f?.close());

  it('creates and paginates canonical items, scopes both query encodings and never mixes dictionaries', async () => {
    const a = await createDictionary('Scoped A'), b = await createDictionary('Scoped B');
    for (const [ordinal, text] of [[2, 'Second'], [0, 'First'], [3, 'Third']] as const) await post('dictionary-item', { dictId: a.id, value: text, text, ordinal }).expect(201);
    await post('dictionary-item', { dictId: b.id, value: 'Other', text: 'Other', ordinal: 0 }).expect(201);
    for (const filter of [{ dictId: a.id }, { 'dictId$eq': a.id }]) {
      const result = (await post('dictionary-item/_query', { filter, pageIndex: 1, pageSize: 1 }).expect(200)).body;
      expect(result).toMatchObject({ total: 3, pageIndex: 1, pageSize: 1, data: [{ dictId: a.id, value: 'Second', text: 'Second', ordinal: 2, name: 'Second', sortIndex: 2 }] }); expect(result.data).toHaveLength(1);
    }
    const types = (await post('dictionary/_query', { filter: { 'classified$eq': 'Scoped A' }, pageSize: 1 }).expect(200)).body;
    expect(types.total).toBe(1); expect(types.data[0].id).toBe(a.id);
    await post('dictionary-item/_query', { filter: { 'dictId$eq': a.id, dictId: b.id } }).expect(400);
    await post('dictionary-item/_query', { filter: { 'dictId$eq': { not: a.id } } }).expect(400);
  });

  it('updates dictionary metadata and item text/ordinal durably while preserving compatibility aliases', async () => {
    const dict = await createDictionary('Edit dictionary'); const service = f.app.get(DictionaryService); await service.findById(dict.id);
    await put(`dictionary/${dict.id}`, { name: 'Edited dictionary', describe: 'Changed' }).expect(200);
    expect(await service.findById(dict.id)).toMatchObject({ name: 'Edited dictionary', describe: 'Changed' });
    const item = (await post('dictionary-item', { dictId: dict.id, label: 'Legacy label', value: 'legacy', sortIndex: 9 }).expect(201)).body;
    expect(item).toMatchObject({ text: 'Legacy label', ordinal: 9, sortIndex: 9 });
    expect((await put(`dictionary-item/${item.id}`, { text: 'Edited item', ordinal: 4, description: 'Item description' }).expect(200)).body).toMatchObject({ text: 'Edited item', name: 'Edited item', ordinal: 4, sortIndex: 4, description: 'Item description' });
    expect(await f.database.model('dictionaryItem').findUnique({ where: { id: item.id } })).toMatchObject({ dictId: dict.id, text: 'Edited item', ordinal: 4, describe: 'Item description' });
    expect((await new DictionaryService(f.database).findDetailById(dict.id))?.items[0]).toMatchObject({ name: 'Edited item', sortIndex: 4, description: 'Item description' });
  });

  it('enforces independent creation and update permissions on both resource types', async () => {
    const dict = (await post('dictionary', { name: 'Creator dictionary', classified: 'creator' }, creator.token).expect(201)).body;
    const item = (await post('dictionary-item', { dictId: dict.id, value: 'p', text: 'Permission item' }, creator.token).expect(201)).body;
    await post('dictionary', { name: 'Denied', classified: 'denied' }, reader.token).expect(403);
    await post('dictionary-item', { dictId: dict.id, value: 'denied', text: 'Denied' }, reader.token).expect(403);
    for (const token of [reader.token, creator.token]) {
      await put(`dictionary/${dict.id}`, { name: 'Denied' }, token).expect(403);
      await put(`dictionary-item/${item.id}`, { text: 'Denied' }, token).expect(403);
    }
    await request(f.app.getHttpServer()).put(`/api/dictionary/${dict.id}`).send({ name: 'Unauthenticated' }).expect(401);
    const editor = await f.member('dicteditor', ['dictionary:query', 'dictionary:update']);
    await put(`dictionary/${dict.id}`, { name: 'Permitted' }, editor.token).expect(200);
    await put(`dictionary-item/${item.id}`, { text: 'Permitted' }, editor.token).expect(200);
  });

  it('returns 409/404/400 without corrupting existing rows or accepting nested writes', async () => {
    const dict = await createDictionary('Conflict dictionary');
    const first = (await post('dictionary-item', { dictId: dict.id, text: 'Original', value: 'same' }).expect(201)).body;
    await post('dictionary-item', { dictId: dict.id, text: 'Duplicate', value: 'same' }).expect(409);
    const other = (await post('dictionary-item', { dictId: dict.id, text: 'Other', value: 'other' }).expect(201)).body;
    await put(`dictionary-item/${other.id}`, { value: 'same', text: 'Overwrite' }).expect(409);
    await put('dictionary/not-present', { name: 'Missing' }).expect(404); await put('dictionary-item/not-present', { text: 'Missing' }).expect(404);
    await post('dictionary-item', { dictId: 'not-present', text: 'Missing', value: 'missing' }).expect(404);
    for (const body of [{ text: '' }, { dictId: dict.id, text: 'Changed owner' }, { ordinal: 1.5 }, { properties: [] }, { dictionary: { delete: true } }]) await put(`dictionary-item/${first.id}`, body).expect(400);
    await put(`dictionary/${dict.id}`, { id: 'changed', items: { deleteMany: {} } }).expect(400);
    await post('dictionary-item/_query', { pageSize: -1 }).expect(400);
    expect(await f.database.model('dictionaryItem').findUnique({ where: { id: first.id } })).toMatchObject({ text: 'Original', value: 'same' });
    expect(await f.database.model('dictionaryItem').findUnique({ where: { id: other.id } })).toMatchObject({ text: 'Other', value: 'other' });
  });

  it('keeps stored values on actual update failure and successfully retries both edits', async () => {
    const dict = await createDictionary('Failure dictionary');
    const item = (await post('dictionary-item', { dictId: dict.id, text: 'Before failure', value: 'failure' }).expect(201)).body;
    await f.withFailedUpdate('dictionaries', async () => { await put(`dictionary/${dict.id}`, { name: 'Retried dictionary' }).expect(500); expect(await f.database.model('dictionary').findUnique({ where: { id: dict.id } })).toMatchObject({ name: 'Failure dictionary' }); });
    await put(`dictionary/${dict.id}`, { name: 'Retried dictionary' }).expect(200);
    await f.withFailedUpdate('dictionary_items', async () => { await put(`dictionary-item/${item.id}`, { text: 'Retried item', ordinal: 7 }).expect(500); expect(await f.database.model('dictionaryItem').findUnique({ where: { id: item.id } })).toMatchObject({ text: 'Before failure', ordinal: 0 }); });
    await put(`dictionary-item/${item.id}`, { text: 'Retried item', ordinal: 7 }).expect(200);
    expect(await new DictionaryService(f.database).findDetailById(dict.id)).toMatchObject({ name: 'Retried dictionary', items: [{ text: 'Retried item', ordinal: 7 }] });
  });

  it('preserves public service aliases through canonical storage and lookup methods', async () => {
    const dict = await createDictionary('Public service'), service = new DictionaryItemService(f.database);
    const item = await service.create({ dictId: dict.id, name: 'Compatibility name', text: 'Canonical label', value: 'legacy', sortIndex: 5, description: 'Stored description', properties: { color: 'blue' }, valueType: 'string', searchCode: 'canon' });
    expect(item).toMatchObject({ text: 'Canonical label', name: 'Canonical label', ordinal: 5, sortIndex: 5, valueType: 'string' });
    await service.update(item.id, { sortIndex: 2, valueType: 'number' });
    expect((await service.findBySearchCode(dict.id, 'can'))[0]).toMatchObject({ ordinal: 2, sortIndex: 2, valueType: 'number', properties: { color: 'blue', valueType: 'number' } });
    const batch = await service.createBatch([{ dictId: dict.id, name: 'A', value: 'a' }, { dictId: dict.id, text: 'B', value: 'b' }]); expect(batch.map(row => row.ordinal)).toEqual([3, 4]);
    expect((await service.findByValues(dict.id, ['a']))[0]).toMatchObject({ text: 'A', name: 'A', sortIndex: 3 });
    expect((await service.getTree(dict.id)).map(row => row.sortIndex)).toEqual([2, 3, 4]);
  });
});
