// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { DimensionUserService, PermissionService, RoleHierarchyService, UserService } from '@zucker-framework/auth';
import { UsersController } from './users.controller';
import type { AdminUserHooks } from './users.options';

const as = (id: string) => ({ user: { id } });

async function harness(options = {}, hooks?: AdminUserHooks) {
  const db = new InMemoryAdapter();
  const permissions = new PermissionService(db);
  permissions.setRoleHierarchyService(new RoleHierarchyService(db));
  const userService = new UserService(db);
  const users = new UsersController(userService, permissions, new DimensionUserService(db), db, options, hooks);
  for (const id of ['root', 'editor', 'authorizer', 'target']) {
    await db.model('users').create({ data: { id, username: id, name: id, typeId: 'member', status: true,
      email: `${id}@example.test`, password: 'hash', mfaSecret: 'secret', credentialVersion: 0 } });
  }
  await db.model('roles').create({ data: { id: 'super-role', name: 'superadmin' } });
  await db.model('userRoles').create({ data: { userId: 'root', roleId: 'super-role' } });
  await db.model('userPermissions').create({ data: { userId: 'editor', permissionId: 'users:update' } });
  for (const code of ['users:update', 'users:authorize'])
    await db.model('userPermissions').create({ data: { userId: 'authorizer', permissionId: code } });
  return { db, users, permissions };
}

describe('UsersController write boundaries (H3)', () => {
  it('rejects unknown and credential-like fields instead of mass-assigning them', async () => {
    const h = await harness();
    for (const body of [{ credentialVersion: 9 }, { creatorId: 'x' }, { mfaSecret: 'x' }, { name: 1 }, [], null])
      await expect(h.users.update('target', body, as('authorizer'))).rejects.toMatchObject({ status: 400 });
    expect(await h.db.model('users').findUnique({ where: { id: 'target' } })).toMatchObject({ credentialVersion: 0, mfaSecret: 'secret' });
  });

  it('lets users:update edit the profile but requires users:authorize for password, email and status changes', async () => {
    const h = await harness();
    await expect(h.users.update('target', { name: 'Renamed' }, as('editor'))).resolves.toMatchObject({ name: 'Renamed' });
    // fe-admin always resends unchanged email/status with the profile: that stays allowed.
    await expect(h.users.update('target', { name: 'Again', email: 'target@example.test', status: true }, as('editor')))
      .resolves.toMatchObject({ name: 'Again' });
    for (const body of [{ password: 'N3w-password!' }, { email: 'attacker@example.test' }, { status: false }, { emailVerified: true }])
      await expect(h.users.update('target', body, as('editor'))).rejects.toMatchObject({ status: 403 });
    await expect(h.users.update('target', { email: 'new@example.test' }, as('authorizer'))).resolves.toMatchObject({ email: 'new@example.test' });
  });

  it('only a superadmin can change, re-role or delete a superadmin account', async () => {
    const h = await harness();
    await expect(h.users.update('root', { name: 'x' }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
    await expect(h.users.update('root', { password: 'N3w-password!' }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
    await expect(h.users.setUserRoles('root', { roleIds: [] }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
    await expect(h.users.setUserPermissions('root', { permissionIds: [] }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
    await expect(h.users.remove('root', as('authorizer'))).rejects.toMatchObject({ status: 403 });
    await expect(h.users.update('root', { name: 'Root' }, as('root'))).resolves.toMatchObject({ name: 'Root' });
  });

  it('returns an explicit projection without credentials or unlisted columns', async () => {
    const h = await harness({ readableFields: ['credentialVersion'] });
    const user = await h.users.findOne('target');
    expect(user).toMatchObject({ id: 'target', username: 'target', email: 'target@example.test', credentialVersion: 0 });
    expect(user).not.toHaveProperty('password');
    expect(user).not.toHaveProperty('mfaSecret');
    const page = await h.users.query({});
    expect(page.data.every(row => !('mfaSecret' in row) && !('password' in row))).toBe(true);
  });

  it('accepts consumer columns only when configured as writable', async () => {
    const h = await harness({ writableFields: ['phone'], readableFields: ['phone'] });
    await expect(h.users.update('target', { phone: '123' }, as('editor'))).resolves.toMatchObject({ phone: '123' });
  });

  it('create ignores client creatorId and records the acting administrator', async () => {
    const h = await harness();
    await expect(h.users.create({ username: 'new', password: 'N3w-password!', creatorId: 'spoofed' }, as('authorizer')))
      .rejects.toMatchObject({ status: 400 });
    const created = await h.users.create({ username: 'new', password: 'N3w-password!', name: 'New', typeId: 'member' }, as('authorizer'));
    expect(created).toMatchObject({ username: 'new', creatorId: 'authorizer' });
    expect(created).not.toHaveProperty('password');
  });

  it('runs the consumer hook after sensitive changes so sessions can be revoked (template M1)', async () => {
    const hooks = { sensitiveFieldsChanged: vi.fn(async () => {}), userDeleted: vi.fn(async () => {}) };
    const h = await harness({}, hooks);
    await h.users.update('target', { name: 'Only profile' }, as('authorizer'));
    expect(hooks.sensitiveFieldsChanged).not.toHaveBeenCalled();
    await h.users.update('target', { password: 'N3w-password!', status: false }, as('authorizer'));
    expect(hooks.sensitiveFieldsChanged).toHaveBeenCalledWith({ userId: 'target', fields: ['password', 'status'], actorId: 'authorizer' });
    await h.users.remove('target', as('authorizer'));
    expect(hooks.userDeleted).toHaveBeenCalledWith('target', 'authorizer');
  });

  it('validates permission and dimension bodies and keeps other grant types', async () => {
    const h = await harness();
    await h.db.model('userPermissions').create({ data: { userId: 'target', permissionId: 'from-plan', grantType: 'plan' } });
    for (const body of [{ permissionIds: 'users:delete' }, { permissionIds: [1] }, { permissionIds: [''] }, { permissionIds: [], extra: 1 }])
      await expect(h.users.setUserPermissions('target', body, as('authorizer'))).rejects.toMatchObject({ status: 400 });
    await h.users.setUserPermissions('target', { permissionIds: ['a', 'a', 'b'] }, as('authorizer'));
    const links = await h.db.model('userPermissions').findMany({ where: { userId: 'target' } }) as Array<{ permissionId: string; grantType: string }>;
    expect(links.map(link => `${link.grantType}:${link.permissionId}`).sort()).toEqual(['direct:a', 'direct:b', 'plan:from-plan']);
    await expect(h.users.setUserDimensions('target', { dimensionIds: [{}] }, as('authorizer'))).rejects.toMatchObject({ status: 400 });
  });

  it('deletes a user when the optional dimension table is unavailable', async () => {
    const h = await harness();
    const model = h.db.model.bind(h.db);
    vi.spyOn(h.db, 'model').mockImplementation((name: string) => {
      if (name !== 'dimensionUsers') return model(name);
      return { ...model(name), deleteMany: async () => { throw new Error('relation "dimension_users" does not exist'); } };
    });
    await h.users.remove('target', as('authorizer'));
    expect(await h.db.model('users').findUnique({ where: { id: 'target' } })).toBeNull();
  });
});
