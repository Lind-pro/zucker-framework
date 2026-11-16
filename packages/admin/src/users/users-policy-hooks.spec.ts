// @vitest-environment node
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { DimensionUserService, PermissionService, RoleHierarchyService, UserService } from '@zucker-framework/auth';
import { UsersController } from './users.controller';
import type { AdminUserHooks } from './users.options';

async function fixture(hooks: AdminUserHooks, expiry = false) {
  const db = new InMemoryAdapter();
  const permissions = new PermissionService(db);
  permissions.setRoleHierarchyService(new RoleHierarchyService(db));
  const bus = { publish: vi.fn().mockResolvedValue(undefined) };
  const users = new UserService(db, undefined, bus);
  const controller = new UsersController(users, permissions, new DimensionUserService(db), db, {}, hooks, { expiry });
  for (const id of ['root', 'target']) await db.model('users').create({ data: { id, username: id, status: true, emailVerified: true, email: `${id}@example.test` } });
  for (const [id, name] of [['root-role', 'superadmin'], ['old', 'reader'], ['new', 'editor']]) await db.model('roles').create({ data: { id, name, status: true } });
  await db.model('userRoles').create({ data: { userId: 'root', roleId: 'root-role' } });
  await db.model('userRoles').create({ data: { userId: 'target', roleId: 'old' } });
  return { db, controller, bus, actor: { user: { id: 'root' } } };
}

describe('admin transactional pre-mutation policy hooks', () => {
  it('rejects a user change before credential mutation or events', async () => {
    const hook = vi.fn<NonNullable<AdminUserHooks['userChanging']>>(async (change, tx) => {
      expect(change).toEqual({ userId: 'target', changes: { status: false }, actorId: 'root' });
      expect(await tx.model('users').findUnique({ where: { id: 'target' } })).toMatchObject({ status: true });
      throw new ForbiddenException('product policy rejected');
    });
    const sensitive = vi.fn().mockResolvedValue(undefined);
    const h = await fixture({ userChanging: hook, sensitiveFieldsChanging: sensitive });
    await expect(h.controller.update('target', { status: false }, h.actor)).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('users').findUnique({ where: { id: 'target' } })).toMatchObject({ status: true });
    expect(sensitive).not.toHaveBeenCalled(); expect(h.bus.publish).not.toHaveBeenCalled();
  });

  it('rejects a validated role replacement transaction without losing existing bindings', async () => {
    const hook = vi.fn<NonNullable<AdminUserHooks['userRolesChanging']>>(async (change, tx) => {
      expect(change).toEqual({ userId: 'target', roleIds: ['new'], expiries: undefined, actorId: 'root' });
      expect(await tx.model('userRoles').findMany({ where: { userId: 'target' } })).toMatchObject([{ roleId: 'old' }]);
      throw new ForbiddenException('role policy rejected');
    });
    const h = await fixture({ userRolesChanging: hook });
    await expect(h.controller.setUserRoles('target', { roleIds: ['new', 'new'] }, h.actor)).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('userRoles').findMany({ where: { userId: 'target' } })).toMatchObject([{ roleId: 'old' }]);
  });

  it('lets policy acceptance proceed before transactional session effects and commit notifications', async () => {
    const order: string[] = [];
    const h = await fixture({
      userChanging: async (_change, tx) => { order.push('policy'); expect(await tx.model('users').findUnique({ where: { id: 'target' } })).toMatchObject({ status: true }); },
      sensitiveFieldsChanging: async (_change, tx) => { order.push('sensitive'); expect(await tx.model('users').findUnique({ where: { id: 'target' } })).toMatchObject({ status: false }); expect(h.bus.publish).not.toHaveBeenCalled(); },
    });
    await h.controller.update('target', { status: false }, h.actor);
    expect(order).toEqual(['policy', 'sensitive']);
    expect(h.bus.publish).toHaveBeenCalled();
  });

  it('provides validated role expiries to policy before persisting assignments', async () => {
    const hook = vi.fn<NonNullable<AdminUserHooks['userRolesChanging']>>().mockResolvedValue(undefined);
    const h = await fixture({ userRolesChanging: hook }, true);
    const expiry = '2027-01-31T23:59:59.000Z';
    await h.controller.setUserRoles('target', { roleIds: ['new'], expiries: { new: expiry } }, h.actor);
    expect(hook).toHaveBeenCalledWith({ userId: 'target', roleIds: ['new'], expiries: { new: expiry }, actorId: 'root' },
      expect.objectContaining({ model: expect.any(Function) }));
    await expect(h.controller.setUserRoles('target', { roleIds: ['new'], expiries: { other: expiry } }, h.actor)).rejects.toMatchObject({ status: 400 });
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
