import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { PermissionService, RoleHierarchyService } from '@zucker-framework/auth';
import { RolesController } from './roles.controller';

describe('RolesController query', () => {
  it('pages roles in the database in a stable order so a picker never skips or repeats a role', async () => {
    const rows = Array.from({ length: 2 }, (_, index) => ({ id: `role-${index + 2}`, name: `Role ${index + 2}` }));
    const model = { findMany: vi.fn().mockResolvedValue(rows), count: vi.fn().mockResolvedValue(5) };
    const database = { model: vi.fn(() => model) };
    const controller = new RolesController({} as never, database as never, {} as never);
    expect(await controller.query({ pageIndex: 1, pageSize: 2, filter: { status: true } })).toEqual({
      data: rows,
      total: 5,
      pageIndex: 1,
      pageSize: 2,
    });
    expect(database.model).toHaveBeenCalledWith('roles');
    expect(model.findMany).toHaveBeenCalledWith({ where: { status: true }, orderBy: [{ id: 'asc' }], skip: 2, take: 2 });
    expect(model.count).toHaveBeenCalledWith({ where: { status: true } });
    await expect(controller.query({ filter: { OR: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.query({ pageSize: 5000 })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RolesController privileged grants (N1)', () => {
  async function harness() {
    const db = new InMemoryAdapter();
    const permissions = new PermissionService(db);
    const hierarchy = new RoleHierarchyService(db);
    permissions.setRoleHierarchyService(hierarchy);
    const roles = new RolesController(hierarchy, db, permissions);
    for (const id of ['root', 'operator'])
      await db.model('users').create({ data: { id, username: id, name: id, typeId: 'member', status: true } });
    await db.model('roles').create({ data: { id: 'super-role', name: 'superadmin' } });
    await db.model('roles').create({ data: { id: 'plain', name: 'plain' } });
    await db.model('userRoles').create({ data: { userId: 'root', roleId: 'super-role' } });
    for (const code of ['roles:add', 'roles:update', 'roles:authorize'])
      await db.model('userPermissions').create({ data: { userId: 'operator', permissionId: code } });
    return { db, roles };
  }
  const operator = { user: { id: 'operator' } };
  const root = { user: { id: 'root' } };

  it('refuses a roles:authorize non-superadmin creating a role named superadmin', async () => {
    const h = await harness();
    await expect(h.roles.create({ name: 'superadmin' }, operator)).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('roles').findMany({ where: { name: 'superadmin' } })).toHaveLength(1);
  });

  it('refuses renaming a role to superadmin', async () => {
    const h = await harness();
    await expect(h.roles.update('plain', { name: 'superadmin' }, operator)).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('roles').findUnique({ where: { id: 'plain' } })).toMatchObject({ name: 'plain' });
  });

  it('refuses parenting a role under the superadmin role', async () => {
    const h = await harness();
    await expect(h.roles.update('plain', { parentId: 'super-role' }, operator)).rejects.toMatchObject({ status: 403 });
    await expect(h.roles.create({ name: 'child', parentId: 'super-role' }, operator)).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('roles').findUnique({ where: { id: 'plain' } })).not.toMatchObject({ parentId: 'super-role' });
  });

  it('refuses linking the * wildcard or superadmin permission to a role', async () => {
    const h = await harness();
    await expect(h.roles.update('plain', { permissionIds: ['*'] }, operator)).rejects.toMatchObject({ status: 403 });
    await expect(h.roles.update('plain', { permissionIds: ['superadmin'] }, operator)).rejects.toMatchObject({ status: 403 });
    await expect(h.roles.create({ name: 'wild', permissionIds: ['*'] }, operator)).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('rolePermissions').findMany({ where: { roleId: 'plain' } })).toEqual([]);
  });

  it('lets a superadmin do all of the above', async () => {
    const h = await harness();
    await expect(h.roles.create({ name: 'superadmin' }, root)).resolves.toMatchObject({ name: 'superadmin' });
    await expect(h.roles.update('plain', { parentId: 'super-role' }, root)).resolves.toMatchObject({ parentId: 'super-role' });
    await expect(h.roles.update('plain', { permissionIds: ['*'] }, root)).resolves.toMatchObject({ permissionIds: ['*'] });
  });

  it('still lets a roles:authorize operator manage ordinary roles', async () => {
    const h = await harness();
    await expect(h.roles.create({ name: 'ordinary', permissionIds: ['users:query'] }, operator)).resolves.toMatchObject({ permissionIds: ['users:query'] });
    await expect(h.roles.update('plain', { name: 'renamed', parentId: 'plain2' }, operator)).resolves.toMatchObject({ name: 'renamed' });
  });
});
