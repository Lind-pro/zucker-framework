import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  managementFixture,
  seedManagementRecords,
  seedManagementApiKeys,
} from './helpers/management-fixture';
import { createAdministrator } from '../src/accounts/create-administrator';
import { createCreditLedger } from '../src/billing/ledger';
import { ManagementService } from '../src/management/management.service';
const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('management PostgreSQL permissions, projections and lot-aware grants', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>,
    owner: { userId: string; token: string },
    other: { userId: string; token: string },
    reader: { userId: string; token: string };
  const get = (path: string, token = f.admin.token) =>
    request(f.app.getHttpServer())
      .get(`/api/management/${path}`)
      .set('Authorization', `Bearer ${token}`);
  const grant = (
    key: string,
    body: object = { amount: 40, description: 'Synthetic support grant' },
    token = f.admin.token,
    target = owner.userId,
  ) =>
    request(f.app.getHttpServer())
      .post(`/api/management/credits/${target}/grants`)
      .set('Origin', f.origin)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!);
    owner = await f.member('grantowner');
    other = await f.member('grantother');
    reader = await f.member('grantreader', ['credit:query']);
  });
  afterAll(async () => {
    await f?.close();
  });
  it('initializes grouped real menus without overwriting an existing custom menu', async () => {
    const menus = (await f.database.model('menus').findMany()) as {
      id: string;
      parentId: string;
      path: string;
    }[];
    expect(menus.find((row) => row.id === 'starter:users')?.parentId).toBe('starter:identity');
    expect(menus.some((row) => row.path === '/content')).toBe(true);
    expect(menus.some((row) => row.path === '/records/jobs')).toBe(true);
    expect(menus.some((row) => row.path === '/tenant' || row.path === '/i18n')).toBe(false);
    await f.database.model('menus').update({
      where: { id: 'starter:users' },
      data: { name: 'Owner custom name', sortOrder: 999 },
    });
    await createAdministrator(f.database, {
      username: 'secondadmin',
      email: 'second@example.invalid',
      password: f.password,
    });
    expect(
      await f.database.model('menus').findUnique({ where: { id: 'starter:users' } }),
    ).toMatchObject({ name: 'Owner custom name', sortOrder: 999 });
  });
  it('requires the individual resource permission and a separate grant permission', async () => {
    await request(f.app.getHttpServer()).get('/api/management/orders').expect(401);
    for (const resource of [
      'orders',
      'billing-subscriptions',
      'jobs',
      'deliveries',
      'files',
      'access-logs',
      'operation-logs',
      'credits',
    ]) {
      await get(resource, owner.token).expect(403);
      await get(resource).expect(200);
    }
    await get('credits', reader.token).expect(200);
    await grant('denied', undefined, reader.token).expect(403);
    await grant('cross-site').set('Origin', 'https://foreign.invalid').expect(403);
  });
  it('commits a grant, batch, available balance, journal and actor audit exactly once across concurrent retry', async () => {
    const results = await Promise.all([grant('same-grant'), grant('same-grant')]);
    expect(results.map((row) => row.status)).toEqual([200, 200]);
    expect(results.filter((row) => row.body.applied)).toHaveLength(1);
    const restarted = new ManagementService(
      f.database,
      f.app.get((await import('../src/credits/credits.service')).CreditsService),
    );
    expect(
      await restarted.grant(f.admin.userId, owner.userId, 'same-grant', {
        amount: 40,
        description: 'Synthetic support grant',
      }),
    ).toMatchObject({ applied: false });
    expect((await get(`credits/${owner.userId}/balance`).expect(200)).body.available).toBe(40);
    expect(await f.database.model('creditLots').count({ where: { userId: owner.userId } })).toBe(1);
    expect(
      await f.database.model('creditTransaction').count({ where: { userId: owner.userId } }),
    ).toBe(1);
    const audits = await f.database
      .model('operationLogs')
      .findMany({ where: { module: 'credits', action: 'grant', targetId: owner.userId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: f.admin.userId });
    await grant('same-grant', { amount: 41, description: 'Synthetic support grant' }).expect(409);
    await grant('same-grant', { amount: 40, description: 'Changed reason' }).expect(409);
    await grant('same-grant', undefined, f.admin.token, other.userId).expect(409);
    const ledger = createCreditLedger(f.database);
    await f.database.transaction((tx) =>
      ledger.consume(tx, {
        accountId: owner.userId,
        amount: 5,
        transactionData: { type: 'CONSUME', description: 'Synthetic consume' },
        consumptionData: { resourceType: 'test', resourceId: 'admin-grant-spend' },
      }),
    );
    expect((await get(`credits/${owner.userId}/balance`).expect(200)).body.available).toBe(35);
  });
  it('rejects invalid grants and rolls all grant evidence back if the audit write fails', async () => {
    for (const body of [
      { amount: 0, description: 'zero' },
      { amount: -1, description: 'negative' },
      { amount: 1.5, description: 'fraction' },
      { amount: 1, description: '' },
      { amount: 1, description: 'injected', actorId: other.userId },
    ])
      await grant('invalid', body).expect(400);
    await f.pool.query(
      `ALTER TABLE "${f.schema}".operation_logs RENAME TO unavailable_operation_logs`,
    );
    try {
      await grant(
        'rollback',
        { amount: 7, description: 'Rollback on audit failure' },
        f.admin.token,
        other.userId,
      ).expect(503);
    } finally {
      await f.pool.query(
        `ALTER TABLE "${f.schema}".unavailable_operation_logs RENAME TO operation_logs`,
      );
    }
    expect(await f.database.model('creditLots').count({ where: { userId: other.userId } })).toBe(0);
    await grant(
      'rollback',
      { amount: 7, description: 'Rollback on audit failure' },
      f.admin.token,
      other.userId,
    ).expect(200);
    expect((await get(`credits/${other.userId}/balance`).expect(200)).body.available).toBe(7);
  });
  it('applies owner filtering, bounded paging and safe projections without provider secrets', async () => {
    await seedManagementRecords(f, owner.userId);
    const orders = (await get('orders?page=1&pageSize=1').expect(200)).body;
    expect(orders.total).toBe(2);
    expect(orders.data).toHaveLength(1);
    expect(orders.data[0]).toMatchObject({
      title: 'Synthetic safe offer',
      money: { amount: '10.00', currency: 'USD' },
    });
    const subscriptionOrder = (await get('orders?id=projection-order-one').expect(200)).body
      .data[0];
    expect(subscriptionOrder).toMatchObject({
      mode: 'subscription',
      fulfilledAt: null,
      subscriptionRecordId: 'projection-subscription',
    });
    const second = (await get('orders?page=2&pageSize=1').expect(200)).body;
    expect(second.data[0].id).not.toBe(orders.data[0].id);
    for (const resource of ['orders', 'billing-subscriptions', 'jobs', 'deliveries']) {
      const projection = await get(resource).expect(200);
      expect(JSON.stringify(projection.body)).not.toMatch(
        /PRIVATE-|fulfillmentData|providerMetadata|leaseToken|payload|customerId|accountScope|createKey|captureKey/,
      );
    }

    expect(
      (await get(`credits?ownerId=${owner.userId}`).expect(200)).body.data.every(
        (row: { userId: string }) => row.userId === owner.userId,
      ),
    ).toBe(true);
    const file = {
      id: 'synthetic-file',
      ownerId: owner.userId,
      idempotencyKey: 'private-key',
      objectKey: 'private/object-key',
      fileName: 'sample.txt',
      sha256: 'a'.repeat(64),
      size: 6,
      mimeType: 'text/plain',
      state: 'ready',
    };
    await f.database.model('fileAssets').create({ data: file });
    const response = (await get('files').expect(200)).body;
    expect(response.data[0]).toMatchObject({ id: file.id, fileName: 'sample.txt' });
    expect(JSON.stringify(response)).not.toMatch(/objectKey|private-key|sha256/);
    await get('files?where=anything').expect(400);
    await get('jobs?status=INVALID').expect(400);
    await get('files?pageSize=101').expect(400);
    await f.pool.query(`ALTER TABLE "${f.schema}".file_assets RENAME TO unavailable_file_assets`);
    try {
      await get('files').expect(503);
    } finally {
      await f.pool.query(`ALTER TABLE "${f.schema}".unavailable_file_assets RENAME TO file_assets`);
    }
  });
  it('exposes read-only API key metadata behind an explicit permission, with owner/status filters and no hashes', async () => {
    await seedManagementApiKeys(f, owner.userId);
    const keyViewer = await f.member('keyviewer', ['api-keys:query']);
    await get('api-keys', owner.token).expect(403);
    const result = (
      await get(`api-keys?ownerId=${owner.userId}&pageSize=1`, keyViewer.token).expect(200)
    ).body;
    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ userId: owner.userId, username: 'grantowner' });
    for (const status of ['active', 'revoked', 'expired']) {
      const filtered = (await get(`api-keys?status=${status}`, keyViewer.token).expect(200)).body;
      expect(filtered.total).toBe(1);
      expect(filtered.data[0].status).toBe(status);
      expect(JSON.stringify(filtered)).not.toMatch(/PRIVATE-HASH|keyHash|secretKey/);
    }
    await request(f.app.getHttpServer())
      .post('/api/management/api-keys')
      .set('Authorization', `Bearer ${f.admin.token}`)
      .set('Origin', f.origin)
      .send({})
      .expect(404);
  });
  it('returns only local connection metadata and rejects unauthorized settings reads', async () => {
    await get('connections', owner.token).expect(403);
    const response = await get('connections').expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.externalRequests).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('SYNTHETIC-SECRET-NEVER-EXPOSE');
    expect(
      response.body.connections.find((row: { id: string }) => row.id === 'payment-stripe'),
    ).toMatchObject({ status: 'missing', source: 'server-environment' });
  });
});
