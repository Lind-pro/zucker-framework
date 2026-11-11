// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { DimensionUserService, PermissionService, RoleHierarchyService, UserService } from '@zucker-framework/auth';
import { UsersController } from './users.controller';

const as = (id: string) => ({ user: { id } });

async function harness() {
  const db = new InMemoryAdapter();
  const permissions = new PermissionService(db);
  permissions.configureRoleAssignments({ expiry: true });
  permissions.setRoleHierarchyService(new RoleHierarchyService(db));
  const users = new UsersController(new UserService(db), permissions, new DimensionUserService(db), db, {}, undefined, { expiry: true });
  for (const id of ['root', 'authorizer', 'target'])
    await db.model('users').create({ data: { id, username: id, name: id, typeId: 'member', status: true, email: `${id}@example.test`, password: 'x' } });
  await db.model('roles').create({ data: { id: 'super-role', name: 'superadmin' } });
  await db.model('roles').create({ data: { id: 'ordinary', name: 'ordinary' } });
  await db.model('userRoles').create({ data: { userId: 'root', roleId: 'super-role', expiresAt: null } });
  await db.model('userPermissions').create({ data: { userId: 'authorizer', permissionId: 'users:authorize' } });
  return { db, users, permissions };
}

describe('admin role expiries: security edges', () => {
  it('a past expiry is stored but grants nothing, and the permission cache is invalidated on write', async () => {
    const h = await harness();
    await h.users.setUserRoles('target', { roleIds: ['ordinary'], expiries: { ordinary: '2099-01-01T00:00:00Z' } }, as('authorizer'));
    expect(await h.permissions.findUserPermissions('target')).toContain('role:ordinary'); // primes the cache
    await h.users.setUserRoles('target', { roleIds: ['ordinary'], expiries: { ordinary: '2000-01-01T00:00:00Z' } }, as('authorizer'));
    expect(await h.permissions.findUserPermissions('target')).not.toContain('role:ordinary');
  });

  it('an expiry never bypasses the privileged-role check', async () => {
    const h = await harness();
    await expect(h.users.setUserRoles('target', { roleIds: ['super-role'], expiries: { 'super-role': '2099-01-01T00:00:00Z' } }, as('authorizer')))
      .rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('userRoles').findMany({ where: { userId: 'target' } })).toEqual([]);
  });

  it('an invalid expiry leaves the previous assignment untouched (no partial replace)', async () => {
    const h = await harness();
    await h.users.setUserRoles('target', { roleIds: ['ordinary'] }, as('authorizer'));
    await expect(h.users.setUserRoles('target', { roleIds: ['ordinary'], expiries: { ordinary: 'tomorrow' } }, as('authorizer')))
      .rejects.toMatchObject({ status: 400 });
    expect(await h.db.model('userRoles').findMany({ where: { userId: 'target' } })).toHaveLength(1);
  });

  it('rejects hostile expiry shapes: prototype keys, unknown body fields, dates without offset', async () => {
    const h = await harness();
    const hostile = JSON.parse('{"__proto__": "2099-01-01T00:00:00Z"}');
    for (const expiries of [hostile, { ordinary: '2099-01-01T00:00:00' }, { ordinary: '2099-13-45T00:00:00Z' }, { ordinary: '' }, { ordinary: new Date() }])
      await expect(h.users.setUserRoles('target', { roleIds: ['ordinary'], expiries }, as('authorizer')))
        .rejects.toMatchObject({ status: 400 });
    await expect(h.users.setUserRoles('target', { roleIds: ['ordinary'], expiresAt: 'x' }, as('authorizer')))
      .rejects.toMatchObject({ status: 400 });
  });

  it('requires users:authorize semantics: an acting user outranked by a superadmin target is refused', async () => {
    const h = await harness();
    await expect(h.users.setUserRoles('root', { roleIds: ['ordinary'], expiries: { ordinary: '2099-01-01T00:00:00Z' } }, as('authorizer')))
      .rejects.toMatchObject({ status: 403 });
  });
});
