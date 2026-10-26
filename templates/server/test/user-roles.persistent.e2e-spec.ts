import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { managementFixture } from './helpers/management-fixture';

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('administrator user-role replacement on PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>;
  let target: { userId: string; token: string }, reader: { userId: string; token: string };
  const roleA = randomUUID(), roleB = randomUUID();
  const put = (body: unknown, token = f.admin.token, userId = target.userId) => request(f.app.getHttpServer())
    .put(`/api/users/${userId}/roles`).set('Authorization', `Bearer ${token}`).send(body);
  const roleIds = async () => (await f.database.model('userRoles').findMany({ where: { userId: target.userId } }) as Array<{ roleId: string }>).map(row => row.roleId).sort();
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!);
    target = await f.member('role_target'); reader = await f.member('role_reader', ['users:query', 'roles:query']);
    for (const id of [roleA, roleB]) await f.database.model('roles').create({ data: { id, name: `synthetic-${id}` } });
  });
  afterAll(async () => { await f?.close(); });

  it('requires authorization and rejects malformed or unknown identifiers without changing grants', async () => {
    await put({ roleIds: [roleA] }).expect(200);
    await put({ roleIds: [roleB] }, reader.token).expect(403);
    for (const body of [{}, { roleIds: null }, { roleIds: 'role' }, { roleIds: [1] }, { roleIds: [''] }, { roleIds: [roleB], actor: 'injected' }])
      await put(body).expect(400);
    await put({ roleIds: ['unknown-role'] }).expect(400);
    await put({ roleIds: [] }, f.admin.token, 'unknown-user').expect(404);
    expect(await roleIds()).toEqual([roleA]);
  });

  it('deduplicates a replacement and can revoke roles without altering direct grants or credential versions', async () => {
    const before = await f.database.model('users').findUnique({ where: { id: target.userId }, select: { credentialVersion: true } });
    await f.database.model('permissions').create({ data: { id: 'synthetic:direct', name: 'Direct permission' } });
    await f.database.model('userPermissions').create({ data: { userId: target.userId, permissionId: 'synthetic:direct', grantType: 'grant' } });
    expect((await put({ roleIds: [roleB, roleB] }).expect(200)).body).toEqual({ roleIds: [roleB] });
    expect(await roleIds()).toEqual([roleB]);
    await put({ roleIds: [] }).expect(200); expect(await roleIds()).toEqual([]);
    expect(await f.database.model('userPermissions').count({ where: { userId: target.userId, permissionId: 'synthetic:direct' } })).toBe(1);
    expect(await f.database.model('users').findUnique({ where: { id: target.userId }, select: { credentialVersion: true } })).toEqual(before);
  });

  it('rolls back the previous membership set when a real database insertion fails', async () => {
    await put({ roleIds: [roleA] }).expect(200);
    await f.pool.query(`CREATE FUNCTION "${f.schema}".reject_role_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic role write failure'; END $$`);
    await f.pool.query(`CREATE TRIGGER reject_role_insert BEFORE INSERT ON "${f.schema}".user_roles FOR EACH ROW EXECUTE FUNCTION "${f.schema}".reject_role_insert()`);
    try { await put({ roleIds: [roleB] }).expect(500); expect(await roleIds()).toEqual([roleA]); }
    finally {
      await f.pool.query(`DROP TRIGGER reject_role_insert ON "${f.schema}".user_roles`);
      await f.pool.query(`DROP FUNCTION "${f.schema}".reject_role_insert()`);
    }
    await put({ roleIds: [roleB] }).expect(200); expect(await roleIds()).toEqual([roleB]);
  });

  it('serializes concurrent full replacements instead of combining grants from two administrators', async () => {
    await put({ roleIds: [] }).expect(200);
    const original = f.database.$transaction.bind(f.database);
    let firstReached!: () => void, releaseFirst!: () => void, captured = false;
    const paused = new Promise<void>(resolve => { firstReached = resolve; });
    const resume = new Promise<void>(resolve => { releaseFirst = resolve; });
    const transaction = vi.spyOn(f.database, '$transaction').mockImplementation(<T>(work: (tx: DatabaseAdapter) => Promise<T>) => original(async tx => {
      const model = tx.model.bind(tx);
      tx.model = name => {
        const operations = model(name);
        if (name !== 'userRoles') return operations;
        return new Proxy(operations, { get(object, key) {
          if (key === 'deleteMany') return async (...args: Parameters<typeof operations.deleteMany>) => {
            const result = await operations.deleteMany(...args);
            if (!captured) { captured = true; firstReached(); await resume; }
            return result;
          };
          const value = Reflect.get(object, key);
          return typeof value === 'function' ? value.bind(object) : value;
        } });
      };
      return work(tx);
    }));
    const first = put({ roleIds: [roleA] }).then(result => result);
    let second: Promise<request.Response> | undefined;
    try {
      await Promise.race([paused, first.then(result => { throw new Error(`Replacement finished before pause: ${result.status}`); })]);
      second = put({ roleIds: [roleB] }).then(result => result);
      await expect.poll(async () => Number((await f.pool.query<{ count: string }>(
        "SELECT count(*)::text FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
        [`%UPDATE "${f.schema}"."users"%`],
      )).rows[0].count), { timeout: 2000, interval: 25 }).toBe(1);
    } finally {
      releaseFirst();
      expect((await first).status).toBe(200);
      if (second) expect((await second).status).toBe(200);
      transaction.mockRestore();
    }
    expect(await roleIds()).toEqual([roleB]);
  });
});
