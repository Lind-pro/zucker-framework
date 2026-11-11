import { describe, expect, it, vi } from 'vitest';
import { MenuService } from './menu.service';
import { PermissionService } from './permission.service';
import { RoleHierarchyService } from './role-hierarchy.service';

type Row = Record<string, any>;

/** In-memory adapter that evaluates the expiry filter the way the database would. */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: Array<{ model: string; args: Row }> = [];
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
      const value = row[key];
      if (cond === null) return value == null;
      if (cond && typeof cond === 'object' && 'in' in cond) return (cond.in as unknown[]).includes(value);
      if (cond && typeof cond === 'object' && 'gt' in cond) return value != null && value > cond.gt;
      return value === cond;
    });
  const db = {
    model(name: string) {
      return {
        findMany: vi.fn(async (args: Row = {}) => {
          calls.push({ model: name, args });
          return (tables[name] ?? []).filter((row) => matches(row, args.where));
        }),
      };
    },
  };
  return { db, calls };
}

const NOW = Date.parse('2026-11-10T00:00:00Z');
const tables = () => ({
  roles: [
    { id: 'child', name: 'child', parentId: 'parent' },
    { id: 'parent', name: 'parent', parentId: null },
    { id: 'other', name: 'other', parentId: null },
  ],
  userRoles: [
    { userId: 'u1', roleId: 'child', expiresAt: new Date(NOW - 1000) },
    { userId: 'u1', roleId: 'other', expiresAt: null },
    { userId: 'u2', roleId: 'child', expiresAt: new Date(NOW + 5000) },
  ],
  rolePermissions: [
    { roleId: 'child', permissionId: 'post:edit' },
    { roleId: 'parent', permissionId: 'post:read' },
    { roleId: 'other', permissionId: 'misc:ok' },
  ],
  userPermissions: [],
  permissions: [],
  menus: [
    { id: 'm-child', status: true, sortOrder: 1, parentId: null, permissions: ['never'] },
    { id: 'm-other', status: true, sortOrder: 2, parentId: null, permissions: ['never'] },
  ],
  roleMenus: [
    { roleId: 'child', menuId: 'm-child' },
    { roleId: 'other', menuId: 'm-other' },
  ],
});

describe('role expiry on hierarchy, menu and permission reads', () => {
  it('an expired role grants neither its own nor its parents permissions (hierarchy-aware)', async () => {
    const { db } = fakeDb(tables());
    const hierarchy = new RoleHierarchyService(db as never);
    const service = new PermissionService(db as never);
    hierarchy.configureRoleAssignments({ expiry: true });
    service.configureRoleAssignments({ expiry: true }, () => NOW);
    service.setRoleHierarchyService(hierarchy);

    const perms = await service.findUserPermissions('u1');
    expect(perms).toContain('role:other');
    expect(perms).toContain('misc:ok');
    for (const forbidden of ['role:child', 'role:parent', 'post:edit', 'post:read']) {
      expect(perms).not.toContain(forbidden);
    }
    expect(await hierarchy.getUserExpandedPermissionIds('u1')).not.toContain('post:read');
  });

  it('hierarchy expansion with expiry off ignores expiresAt (previous behaviour)', async () => {
    const { db, calls } = fakeDb(tables());
    const hierarchy = new RoleHierarchyService(db as never);
    await hierarchy.getUserExpandedPermissionIds('u1');
    const q = calls.find((c) => c.model === 'userRoles')!;
    expect(q.args).toEqual({ where: { userId: 'u1' }, select: { roleId: true } });
  });

  it('menu: an expired role link no longer reveals its role-linked menus', async () => {
    const { db } = fakeDb(tables());
    const menu = new MenuService(db as never);
    menu.configureRoleAssignments({ expiry: true });
    const ids = (await menu.getMenuTreeByUserId('u1', [])).map((m) => m.id);
    expect(ids).toEqual(['m-other']);

    const off = new MenuService(db as never);
    expect((await off.getMenuTreeByUserId('u1', [])).map((m) => m.id).sort()).toEqual(['m-child', 'm-other']);
  });

  it('cache never serves a hierarchy-derived grant after the earliest expiry', async () => {
    let now = NOW;
    const { db, calls } = fakeDb(tables());
    const hierarchy = new RoleHierarchyService(db as never);
    hierarchy.configureRoleAssignments({ expiry: true });
    const service = new PermissionService(db as never);
    service.configureRoleAssignments({ expiry: true }, () => now);
    service.setRoleHierarchyService(hierarchy);

    expect(await service.findUserPermissions('u2')).toEqual(expect.arrayContaining(['post:read', 'post:edit']));
    now = NOW + 4_999;
    expect(await service.findUserPermissions('u2')).toContain('post:read'); // still cached, still valid
    expect(calls.filter((c) => c.model === 'userRoles')).toHaveLength(1);
    now = NOW + 5_000; // exactly at expiry
    expect(await service.findUserPermissions('u2')).not.toContain('post:read');
    expect(await service.findUserPermissions('u2')).not.toContain('role:child');
  });

  it('invalidatePermissionCache and reconfiguration drop cached grants', async () => {
    const now = NOW;
    const t = tables();
    const { db } = fakeDb(t);
    const service = new PermissionService(db as never);
    service.configureRoleAssignments({ expiry: true }, () => now);
    expect(await service.findUserPermissions('u2')).toContain('role:child');
    t.userRoles.length = 0;
    expect(await service.findUserPermissions('u2')).toContain('role:child'); // cached
    service.invalidatePermissionCache('u2');
    expect(await service.findUserPermissions('u2')).toEqual([]);
  });

  it('permission cache is bounded (oldest entry evicted past 256 users)', async () => {
    const { db, calls } = fakeDb(tables());
    const service = new PermissionService(db as never);
    service.configureRoleAssignments({ expiry: true }, () => NOW);
    for (let i = 0; i < 300; i++) await service.findUserPermissions(`user-${i}`);
    const size = (service as unknown as { permissionCache: Map<string, unknown> }).permissionCache.size;
    expect(size).toBeLessThanOrEqual(256);
    const before = calls.length;
    await service.findUserPermissions('user-299'); // newest is cached
    expect(calls.length).toBe(before);
    await service.findUserPermissions('user-0'); // oldest was evicted
    expect(calls.length).toBeGreaterThan(before);
  });

  it('a malformed expiresAt from the store cannot extend the cache past its TTL', async () => {
    let now = NOW;
    const t = tables();
    t.userRoles = [{ userId: 'u3', roleId: 'other', expiresAt: null }];
    const { db, calls } = fakeDb(t);
    const service = new PermissionService(db as never);
    service.configureRoleAssignments({ expiry: true }, () => now);
    await service.findUserPermissions('u3');
    now += 5_001; // TTL 5s
    await service.findUserPermissions('u3');
    expect(calls.filter((c) => c.model === 'userRoles')).toHaveLength(2);
  });
});
