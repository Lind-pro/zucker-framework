import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { managementFixture } from './helpers/management-fixture';
const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('atomic administrator role metadata and grant replacement on PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>, editor: { userId: string; token: string }, target: { userId: string; token: string };
  const alpha = 'synthetic-atomic:alpha', beta = 'synthetic-atomic:beta';
  const post = (body: object, token = f.admin.token) => request(f.app.getHttpServer()).post('/api/roles').set('Authorization', `Bearer ${token}`).send(body);
  const put = (id: string, body: object, token = f.admin.token) => request(f.app.getHttpServer()).put(`/api/roles/${id}`).set('Authorization', `Bearer ${token}`).send(body);
  const remove = (id: string) => request(f.app.getHttpServer()).delete(`/api/roles/${id}`).set('Authorization', `Bearer ${f.admin.token}`);
  const grants = async (id: string) => (await f.database.model('rolePermissions').findMany({ where: { roleId: id } }) as Array<{ permissionId: string }>).map(row => row.permissionId).sort();
  const create = async (name: string, permissionIds: string[] = []) => (await post({ name, description: 'Original metadata', permissionIds }).expect(201)).body as { id: string; name: string; description: string };
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!);
    editor = await f.member('atomic_role_editor', ['roles:query', 'roles:add', 'roles:update']); target = await f.member('atomic_role_target');
    for (const id of [alpha, beta]) await f.database.model('permissions').create({ data: { id, name: id } });
  });
  afterAll(async () => f?.close());

  async function withDatabaseFailure(event: 'INSERT' | 'DELETE', table: 'role_permissions' | 'roles', work: () => Promise<void>) {
    await f.pool.query(`CREATE FUNCTION "${f.schema}".reject_atomic_role_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic atomic role write failure'; END $$`);
    try {
      await f.pool.query(`CREATE TRIGGER reject_atomic_role_write BEFORE ${event} ON "${f.schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION "${f.schema}".reject_atomic_role_write()`);
      try { await work(); } finally { await f.pool.query(`DROP TRIGGER reject_atomic_role_write ON "${f.schema}"."${table}"`); }
    } finally { await f.pool.query(`DROP FUNCTION "${f.schema}".reject_atomic_role_write()`); }
  }

  function pauseFirstReplacement(id: string) {
    const original = f.database.$transaction.bind(f.database);
    let firstReached: () => void = () => {}, release: () => void = () => {}, captured = false;
    const reached = new Promise<void>(resolve => { firstReached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(f.database, '$transaction').mockImplementation(<T>(work: (tx: DatabaseAdapter) => Promise<T>) => original(async tx => {
      const model = tx.model.bind(tx);
      tx.model = name => {
        const operations = model(name);
        if (name !== 'rolePermissions') return operations;
        return new Proxy(operations, { get(object, key) {
          if (key === 'deleteMany') return async (...args: Parameters<typeof operations.deleteMany>) => {
            const result = await operations.deleteMany(...args);
            if (!captured && (args[0]?.where as { roleId?: string } | undefined)?.roleId === id) { captured = true; firstReached(); await resume; }
            return result;
          };
          const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
        } });
      };
      return work(tx);
    }));
    return { reached, release, restore: () => spy.mockRestore() };
  }
  async function waitForRoleLock() {
    await expect.poll(async () => Number((await f.pool.query<{ count: string }>(
      "SELECT count(*)::text FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
      [`%UPDATE "${f.schema}"."roles"%`],
    )).rows[0].count), { timeout: 2000, interval: 25 }).toBe(1);
  }

  it('keeps metadata-only edits separate from authority and preserves missing-role responses', async () => {
    const role = await create('Atomic metadata', [alpha]);
    await put(role.id, { name: role.name, description: 'Allowed metadata' }, editor.token).expect(200);
    for (const body of [{ name: 'Unauthorized rename' }, { parentId: 'any-parent' }, { permissionIds: [] }]) await put(role.id, body, editor.token).expect(403);
    await post({ name: 'superadmin' }, editor.token).expect(403);
    await put('missing-atomic-role', { description: 'Missing' }).expect(404); await remove('missing-atomic-role').expect(404);
    expect(await grants(role.id)).toEqual([alpha]); expect(await f.database.model('roles').findUnique({ where: { id: role.id } })).toMatchObject({ name: role.name, description: 'Allowed metadata' });
  });

  it('rolls back newly created roles and metadata plus grants when an actual link insert fails', async () => {
    const role = await create('Atomic rollback', [alpha]);
    await withDatabaseFailure('INSERT', 'role_permissions', async () => {
      await post({ name: 'Atomic create must disappear', permissionIds: [beta] }).expect(500);
      expect(await f.database.model('roles').count({ where: { name: 'Atomic create must disappear' } })).toBe(0);
      await put(role.id, { name: 'Atomic failed rename', description: 'Failed metadata', permissionIds: [beta] }).expect(500);
      expect(await f.database.model('roles').findUnique({ where: { id: role.id } })).toMatchObject({ name: role.name, description: 'Original metadata' }); expect(await grants(role.id)).toEqual([alpha]);
    });
    await put(role.id, { name: 'Atomic retried rename', description: 'Retried metadata', permissionIds: [beta] }).expect(200);
    expect(await grants(role.id)).toEqual([beta]); expect(await f.database.model('roles').findUnique({ where: { id: role.id } })).toMatchObject({ name: 'Atomic retried rename', description: 'Retried metadata' });
  });

  it('serializes two full replacements of an initially empty grant set', async () => {
    const role = await create('Atomic concurrent grants'), pause = pauseFirstReplacement(role.id);
    const first = put(role.id, { permissionIds: [alpha] }).then(response => response); let second: Promise<request.Response> | undefined;
    try {
      await Promise.race([pause.reached, first.then(response => { throw new Error(`First replacement finished before barrier: ${response.status}`); })]);
      second = put(role.id, { permissionIds: [beta] }).then(response => response); await waitForRoleLock();
    } finally { pause.release(); try { expect((await first).status).toBe(200); if (second) expect((await second).status).toBe(200); } finally { pause.restore(); } }
    expect(await grants(role.id)).toEqual([beta]);
  });

  it('checks sensitive name changes against the committed role after acquiring its lock', async () => {
    const role = await create('Atomic old name'), pause = pauseFirstReplacement(role.id);
    const first = put(role.id, { name: 'Atomic newer name', permissionIds: [alpha] }).then(response => response); let second: Promise<request.Response> | undefined;
    try {
      await Promise.race([pause.reached, first.then(response => { throw new Error(`Rename finished before barrier: ${response.status}`); })]);
      second = put(role.id, { name: role.name, description: 'Stale editor overwrite' }, editor.token).then(response => response); await waitForRoleLock();
    } finally { pause.release(); try { expect((await first).status).toBe(200); if (second) expect((await second).status).toBe(403); } finally { pause.restore(); } }
    expect(await f.database.model('roles').findUnique({ where: { id: role.id } })).toMatchObject({ name: 'Atomic newer name', description: 'Original metadata' }); expect(await grants(role.id)).toEqual([alpha]);
  });

  it('restores both permission and membership links when role deletion fails, then deletes on retry', async () => {
    const role = await create('Atomic delete rollback', [alpha]); await f.database.model('userRoles').create({ data: { userId: target.userId, roleId: role.id } });
    await withDatabaseFailure('DELETE', 'roles', async () => {
      await remove(role.id).expect(500); expect(await grants(role.id)).toEqual([alpha]);
      expect(await f.database.model('userRoles').count({ where: { roleId: role.id } })).toBe(1);
      expect(await f.database.model('roles').findUnique({ where: { id: role.id } })).not.toBeNull();
    });
    await remove(role.id).expect(204); expect(await grants(role.id)).toEqual([]); expect(await f.database.model('userRoles').count({ where: { roleId: role.id } })).toBe(0);
  });

  it('serializes deletion with an in-flight replacement before removing role links', async () => {
    const role = await create('Atomic delete serialization'), pause = pauseFirstReplacement(role.id);
    const first = put(role.id, { permissionIds: [alpha] }).then(response => response); let deletion: Promise<request.Response> | undefined;
    try {
      await Promise.race([pause.reached, first.then(response => { throw new Error(`Replacement finished before barrier: ${response.status}`); })]);
      deletion = remove(role.id).then(response => response); await waitForRoleLock();
    } finally { pause.release(); try { expect((await first).status).toBe(200); if (deletion) expect((await deletion).status).toBe(204); } finally { pause.restore(); } }
    expect(await f.database.model('roles').findUnique({ where: { id: role.id } })).toBeNull(); expect(await grants(role.id)).toEqual([]);
  });
});
