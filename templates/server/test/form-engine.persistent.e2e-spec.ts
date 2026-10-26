import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { FormService } from '@zucker-framework/form';
import { formEngineFixture } from './helpers/form-engine-fixture';
const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('default form manager PostgreSQL and actual administrator HTTP', () => {
  let f: Awaited<ReturnType<typeof formEngineFixture>>, reader: { token: string }, creator: { token: string };
  const create = (body: object, token = f.admin.token) => request(f.app.getHttpServer()).post('/api/form/definition').set('Authorization', `Bearer ${token}`).send(body);
  const update = (id: string, body: object, token = f.admin.token) => request(f.app.getHttpServer()).put(`/api/form/definition/${id}`).set('Authorization', `Bearer ${token}`).send(body);
  const get = (id: string) => request(f.app.getHttpServer()).get(`/api/form/definition/${id}`).set('Authorization', `Bearer ${f.admin.token}`);
  beforeAll(async () => { f = await formEngineFixture(process.env.TEST_DATABASE_URL!); reader = await f.member('formsreader', ['form:query']); creator = await f.member('formscreator', ['form:query', 'form:add']); });
  afterAll(async () => f?.close());
  it('creates the actual minimal UI payload with generated identity and durable empty fields', async () => {
    const response = await create({ name: 'Synthetic form', description: 'Editable example' }).expect(201);
    expect(response.body).toMatchObject({ name: 'Synthetic form', description: 'Editable example', fields: [], version: 1 }); expect(response.body.id).toBeTruthy();
    expect(await new FormService(f.database).findById(response.body.id)).toMatchObject({ id: response.body.id, name: 'Synthetic form', fields: [], version: 1 });
  });
  it('edits fields and name through PUT and invalidates cached definitions after one persisted update', async () => {
    const response = await create({ name: 'Before' }).expect(201), id = response.body.id; await get(id).expect(200);
    const fields = [{ key: 'email', name: 'Email', type: 'string', required: true }, { key: 'approved', name: 'Approved', type: 'enum', options: [{ label: 'Yes', value: true }, { label: 'No', value: false }] }];
    expect((await update(id, { name: 'After', fields }).expect(200)).body).toMatchObject({ id, name: 'After', fields, version: 2 });
    expect((await get(id).expect(200)).body).toMatchObject({ name: 'After', fields, version: 2 });
    expect(await new FormService(f.database).findById(id)).toMatchObject({ name: 'After', fields, version: 2 });
  });
  it('requires distinct create/update permissions and returns not-found for absent forms', async () => {
    const response = await create({ name: 'Permission example' }, creator.token).expect(201), id = response.body.id;
    await create({ name: 'Denied' }, reader.token).expect(403); await update(id, { name: 'Denied' }, reader.token).expect(403); await update(id, { name: 'Denied' }, creator.token).expect(403);
    await request(f.app.getHttpServer()).put(`/api/form/definition/${id}`).send({ name: 'Denied' }).expect(401);
    await update('not-present', { name: 'Missing' }).expect(404);
    expect((await get(id).expect(200)).body.name).toBe('Permission example');
  });
  it('rejects duplicate identities and invalid field arrays without overwriting existing state', async () => {
    const initial = await create({ id: 'fixed-test-form', name: 'Original' }).expect(201);
    await create({ id: initial.body.id, name: 'Overwrite' }).expect(409);
    for (const body of [{ name: '' }, { name: 'Bad', fields: {} }, { name: 'Bad', fields: [{ key: 'x', name: 'X', type: 'string' }, { key: 'x', name: 'Duplicate', type: 'number' }] }]) await create(body).expect(400);
    await update(initial.body.id, { id: 'new-id', name: 'Changed identity' }).expect(400);
    expect((await get(initial.body.id).expect(200)).body).toMatchObject({ name: 'Original', fields: [], version: 1 });
  });
  it('preserves the old definition when the real update fails and saves the retained payload on retry', async () => {
    const initial = await create({ name: 'Failure example' }).expect(201), id = initial.body.id, body = { name: 'Retry saved', fields: [{ key: 'notes', name: 'Notes', type: 'string' }] };
    await get(id).expect(200);
    await f.withFailedUpdate(async () => { await update(id, body).expect(500); expect(await new FormService(f.database).findById(id)).toMatchObject({ name: 'Failure example', fields: [], version: 1 }); });
    await update(id, body).expect(200); expect(await new FormService(f.database).findById(id)).toMatchObject({ ...body, version: 2 });
  });
});
