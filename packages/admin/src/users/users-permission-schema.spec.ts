import { describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { DimensionUserService, PermissionService, UserService } from '@zucker-framework/auth';
import { UsersController } from './users.controller';

async function fixture() {
  const db = new InMemoryAdapter();
  for (const id of ['root', 'target', 'other']) await db.model('users').create({ data: { id, username: id, status: true } });
  await db.model('roles').create({ data: { id: 'root-role', name: 'superadmin' } });
  await db.model('userRoles').create({ data: { userId: 'root', roleId: 'root-role' } });
  const permissions = new PermissionService(db);
  const users = new UsersController(new UserService(db), permissions, new DimensionUserService(db), db);
  return { db, users };
}

describe('UsersController permission link schema compatibility', () => {
  it('cleans actual null and missing legacy grants by id while preserving other grant types and users', async () => {
    const { db, users } = await fixture();
    for (const [id, userId, permissionId, grantType] of [
      ['old-null', 'target', 'legacy-null', null], ['old-missing', 'target', 'legacy-missing', undefined],
      ['old-direct', 'target', 'legacy-direct', 'direct'], ['plan', 'target', 'from-plan', 'plan'],
      ['grant', 'target', 'from-grant', 'grant'], ['other-null', 'other', 'other-legacy', null],
    ] as const) await db.model('userPermissions').create({ data: { id, userId, permissionId, ...(grantType === undefined ? {} : { grantType }) } });
    await users.setUserPermissions('target', { permissionIds: ['new-permission'] }, { user: { id: 'root' } });
    const rows = await db.model('userPermissions').findMany({ where: { userId: 'target' } }) as Array<{ permissionId: string; grantType?: string | null }>;
    expect(rows.map(row => `${row.grantType}:${row.permissionId}`).sort()).toEqual(['direct:new-permission', 'grant:from-grant', 'plan:from-plan']);
    expect(await db.model('userPermissions').findUnique({ where: { id: 'other-null' } })).not.toBeNull();
  });

  it('does not query a nullable grantType predicate against a non-null consumer column', async () => {
    const { db, users } = await fixture();
    const model = db.model.bind(db);
    const deletes: unknown[] = [];
    vi.spyOn(db, 'model').mockImplementation(name => {
      const delegate = model(name);
      if (name !== 'userPermissions') return delegate;
      return new Proxy(delegate, { get(target, property) {
        if (property !== 'deleteMany') return Reflect.get(target, property);
        return async (input: Parameters<typeof target.deleteMany>[0]) => {
          deletes.push(input);
          if ((input as { where?: { grantType?: unknown } })?.where?.grantType === null) throw new Error('Non-null grantType rejects null filters');
          return target.deleteMany(input);
        };
      } });
    });
    await expect(users.setUserPermissions('target', { permissionIds: ['new-permission'] }, { user: { id: 'root' } }))
      .resolves.toEqual({ permissionIds: ['new-permission'] });
    expect(deletes).toHaveLength(1);
  });
});
