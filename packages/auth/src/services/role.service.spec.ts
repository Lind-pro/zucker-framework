import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryAdapter } from '@zucker/crud';
import { RoleService } from './role.service';
import { PermissionService } from './permission.service';
import { BusinessException, NotFoundException } from '@zucker/core';

// Suppress NestJS Logger output
vi.mock('@nestjs/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/common')>();
  return {
    ...actual,
    Logger: class {
      log = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
  };
});

describe('RoleService', () => {
  let db: InMemoryAdapter;
  let roleService: RoleService;
  let permissionService: PermissionService;

  beforeEach(() => {
    db = new InMemoryAdapter();
    permissionService = new PermissionService(db as any);
    // RoleService constructor: @Inject(DATABASE_ADAPTER) db, @Optional() topicEventBus, @Optional() permissionService
    roleService = new RoleService(db as any, undefined, permissionService);
  });

  // ─── addRole ───────────────────────────────────────────────────────

  it('addRole: creates a role successfully', async () => {
    const role = await roleService.addRole({ name: 'editor' });

    expect(role.name).toBe('editor');
    expect(role.id).toBeDefined();
    expect(role.status).toBe(true);
  });

  it('addRole: throws on duplicate name', async () => {
    await roleService.addRole({ name: 'editor' });

    await expect(roleService.addRole({ name: 'editor' })).rejects.toThrow(
      BusinessException,
    );
    await expect(roleService.addRole({ name: 'editor' })).rejects.toThrow(
      /已存在/,
    );
  });

  // ─── updateRole ────────────────────────────────────────────────────

  it('updateRole: updates role fields', async () => {
    const role = await roleService.addRole({ name: 'editor' });
    const updated = await roleService.updateRole(role.id, { description: 'Content editor' });

    expect(updated.description).toBe('Content editor');
    expect(updated.name).toBe('editor');
  });

  it('updateRole: throws on name conflict with another role', async () => {
    const role1 = await roleService.addRole({ name: 'editor' });
    await roleService.addRole({ name: 'admin' });

    await expect(
      roleService.updateRole(role1.id, { name: 'admin' }),
    ).rejects.toThrow(BusinessException);
  });

  it('updateRole: allows keeping the same name', async () => {
    const role = await roleService.addRole({ name: 'editor' });

    // Updating with the same name should not throw
    const updated = await roleService.updateRole(role.id, { name: 'editor', description: 'Updated' });
    expect(updated.description).toBe('Updated');
  });

  it('updateRole: throws NotFoundException for non-existent role', async () => {
    await expect(
      roleService.updateRole('nonexistent', { name: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── deleteRole ────────────────────────────────────────────────────

  it('deleteRole: cascade deletes related records and invalidates cache', async () => {
    const role = await roleService.addRole({ name: 'editor' });

    // Seed related records
    await db.model('rolePermissions').create({ data: { id: 'rp1', roleId: role.id, permissionId: 'p1' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: role.id } });
    await db.model('roleMenus').create({ data: { id: 'rm1', roleId: role.id, menuId: 'm1' } });

    // Populate permission cache for a user with this role
    await permissionService.findUserPermissions('u1');

    // Spy on cache invalidation
    const invalidateSpy = vi.spyOn(permissionService, 'invalidatePermissionCache');

    const result = await roleService.deleteRole(role.id);
    expect(result).toBe(true);

    // Verify cascade deletion
    const remainingRolePerms = await db.model('rolePermissions').findMany({ where: { roleId: role.id } });
    expect(remainingRolePerms).toHaveLength(0);

    const remainingUserRoles = await db.model('userRoles').findMany({ where: { roleId: role.id } });
    expect(remainingUserRoles).toHaveLength(0);

    const remainingRoleMenus = await db.model('roleMenus').findMany({ where: { roleId: role.id } });
    expect(remainingRoleMenus).toHaveLength(0);

    // Role itself should be gone
    const deletedRole = await roleService.findById(role.id);
    expect(deletedRole).toBeNull();

    // Cache should have been invalidated
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('deleteRole: returns false for non-existent role', async () => {
    const result = await roleService.deleteRole('nonexistent');
    expect(result).toBe(false);
  });

  // ─── setRolePermissions ────────────────────────────────────────────

  it('setRolePermissions: sets permissions and deduplicates', async () => {
    const role = await roleService.addRole({ name: 'editor' });

    // Pass duplicates
    await roleService.setRolePermissions(role.id, ['p1', 'p2', 'p1', 'p3', 'p2']);

    const perms = await roleService.getRolePermissions(role.id);
    expect(perms.sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('setRolePermissions: replaces existing permissions', async () => {
    const role = await roleService.addRole({ name: 'editor' });

    await roleService.setRolePermissions(role.id, ['p1', 'p2']);
    let perms = await roleService.getRolePermissions(role.id);
    expect(perms.sort()).toEqual(['p1', 'p2']);

    // Replace with new set
    await roleService.setRolePermissions(role.id, ['p3']);
    perms = await roleService.getRolePermissions(role.id);
    expect(perms).toEqual(['p3']);
  });

  it('setRolePermissions: invalidates permission cache', async () => {
    const role = await roleService.addRole({ name: 'editor' });

    const invalidateSpy = vi.spyOn(permissionService, 'invalidatePermissionCache');

    await roleService.setRolePermissions(role.id, ['p1']);

    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('setRolePermissions: throws NotFoundException for non-existent role', async () => {
    await expect(
      roleService.setRolePermissions('nonexistent', ['p1']),
    ).rejects.toThrow(NotFoundException);
  });
});
