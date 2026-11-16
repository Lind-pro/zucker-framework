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
  return { db, users, permissions, userService };
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

  it('runs the consumer hook inside sensitive changes so sessions can be revoked atomically', async () => {
    const hooks = { sensitiveFieldsChanging: vi.fn(async () => {}), userDeleted: vi.fn(async () => {}) };
    const h = await harness({}, hooks);
    await h.users.update('target', { name: 'Only profile' }, as('authorizer'));
    expect(hooks.sensitiveFieldsChanging).not.toHaveBeenCalled();
    await h.users.update('target', { password: 'N3w-password!', status: false }, as('authorizer'));
    expect(hooks.sensitiveFieldsChanging).toHaveBeenCalledWith({ userId: 'target', fields: ['password', 'status'], actorId: 'authorizer' }, expect.objectContaining({ model: expect.any(Function) }));
    await h.users.remove('target', as('authorizer'));
    expect(hooks.userDeleted).toHaveBeenCalledWith('target', 'authorizer');
  });

  it('refuses a legacy security hook before any credential writes can occur', async () => {
    await expect(harness({}, { sensitiveFieldsChanged: async () => {} })).rejects.toThrow('migrate to sensitiveFieldsChanging');
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

describe('UsersController privileged grants (N1)', () => {
  const asRoot = as('root');

  it('refuses a users:authorize operator granting superadmin to itself or others', async () => {
    const h = await harness();
    await expect(h.users.setUserRoles('authorizer', { roleIds: ['super-role'] }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
    await expect(h.users.setUserRoles('target', { roleIds: ['super-role'] }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('userRoles').findMany({ where: { userId: 'authorizer' } })).toEqual([]);
    expect(await h.permissions.hasPermission('authorizer', ['config:update'])).toBe(false);
  });

  it('refuses a role whose parentId chain reaches a role named superadmin', async () => {
    const h = await harness();
    await h.db.model('roles').create({ data: { id: 'mid', name: 'mid', parentId: 'super-role' } });
    await h.db.model('roles').create({ data: { id: 'leaf', name: 'leaf', parentId: 'mid' } });
    await expect(h.users.setUserRoles('target', { roleIds: ['leaf'] }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('userRoles').findMany({ where: { userId: 'target' } })).toEqual([]);
    await expect(h.users.setUserRoles('target', { roleIds: ['leaf'] }, asRoot)).resolves.toEqual({ roleIds: ['leaf'] });
  });

  it('refuses a role linked to the * wildcard permission', async () => {
    const h = await harness();
    await h.db.model('roles').create({ data: { id: 'wild', name: 'wild' } });
    await h.db.model('rolePermissions').create({ data: { roleId: 'wild', permissionId: '*' } });
    await expect(h.users.setUserRoles('target', { roleIds: ['wild'] }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
  });

  it('refuses direct superadmin and * permission ids from a non-superadmin', async () => {
    const h = await harness();
    for (const permissionIds of [['superadmin'], ['*'], ['users:query', '*']])
      await expect(h.users.setUserPermissions('target', { permissionIds }, as('authorizer'))).rejects.toMatchObject({ status: 403 });
    expect(await h.db.model('userPermissions').findMany({ where: { userId: 'target' } })).toEqual([]);
  });

  it('lets a superadmin grant superadmin roles and permissions', async () => {
    const h = await harness();
    await expect(h.users.setUserRoles('target', { roleIds: ['super-role'] }, asRoot)).resolves.toEqual({ roleIds: ['super-role'] });
    await expect(h.users.setUserPermissions('target', { permissionIds: ['superadmin', '*'] }, asRoot))
      .resolves.toEqual({ permissionIds: ['superadmin', '*'] });
  });

  it('still lets users:authorize assign ordinary roles and permissions', async () => {
    const h = await harness();
    await h.db.model('roles').create({ data: { id: 'ordinary', name: 'ordinary' } });
    await expect(h.users.setUserRoles('target', { roleIds: ['ordinary'] }, as('authorizer'))).resolves.toEqual({ roleIds: ['ordinary'] });
    await expect(h.users.setUserPermissions('target', { permissionIds: ['users:query'] }, as('authorizer')))
      .resolves.toEqual({ permissionIds: ['users:query'] });
  });

  it('refuses privileged grants when there is no acting user', async () => {
    const h = await harness();
    await expect(h.users.setUserRoles('target', { roleIds: ['super-role'] })).rejects.toMatchObject({ status: 403 });
    await expect(h.users.setUserRoles('target', { roleIds: ['super-role'] }, { user: {} })).rejects.toMatchObject({ status: 403 });
    await expect(h.users.setUserPermissions('target', { permissionIds: ['*'] })).rejects.toMatchObject({ status: 403 });
  });
});

describe('UsersController update edge cases (N17)', () => {
  it('treats an empty email form value as unchanged when the stored email is null', async () => {
    const h = await harness();
    await h.db.model('users').update({ where: { id: 'target' }, data: { email: null } });
    await expect(h.users.update('target', { name: 'Renamed', email: '' }, as('editor'))).resolves.toMatchObject({ name: 'Renamed' });
  });

  it('fails without re-inserting when the user is deleted between the read and the write', async () => {
    const h = await harness();
    const update = h.userService.updateUser.bind(h.userService);
    const spy = vi.spyOn(h.userService, 'updateUser').mockImplementationOnce(async (id, changes, options) => {
      await h.db.model('users').delete({ where: { id: 'target' } });
      return update(id, changes, options);
    });
    await expect(h.users.update('target', { name: 'Ghost' }, as('editor'))).rejects.toBeInstanceOf(Error);
    spy.mockRestore();
    expect(await h.db.model('users').findUnique({ where: { id: 'target' } })).toBeNull();
    expect(await h.db.model('users').findMany({ where: { name: 'Ghost' } })).toEqual([]);
  });
});

describe('UsersController role expiries (WP 3.3a)', () => {
  async function withExpiry(expiry: boolean) {
    const h = await harness();
    const users = new UsersController(h.userService, h.permissions, new DimensionUserService(h.db), h.db, {}, undefined, { expiry });
    await h.db.model('roles').create({ data: { id: 'ordinary', name: 'ordinary' } });
    await h.db.model('roles').create({ data: { id: 'other', name: 'other' } });
    return { ...h, users };
  }

  it('rejects expiries with 400 when expiry is off and omits them from GET', async () => {
    const h = await withExpiry(false);
    await expect(h.users.setUserRoles('target', { roleIds: ['ordinary'], expiries: { ordinary: null } }, as('authorizer')))
      .rejects.toMatchObject({ status: 400 });
    await h.users.setUserRoles('target', { roleIds: ['ordinary'] }, as('authorizer'));
    const links = await h.db.model('userRoles').findMany({ where: { userId: 'target' } });
    expect(links.every((link) => !('expiresAt' in (link as object)))).toBe(true);
    expect(await h.users.getUserRoles('target')).not.toHaveProperty('expiries');
  });

  it('writes and returns expiries when expiry is on, validating keys and dates', async () => {
    const h = await withExpiry(true);
    const at = '2027-01-31T23:59:59.000Z';
    await expect(h.users.setUserRoles('target', { roleIds: ['ordinary', 'other'], expiries: { ordinary: at } }, as('authorizer')))
      .resolves.toEqual({ roleIds: ['ordinary', 'other'], expiries: { ordinary: at, other: null } });
    expect((await h.users.getUserRoles('target')).expiries).toEqual({ ordinary: at, other: null });
    for (const expiries of [{ missing: at }, { ordinary: '2027-01-31' }, { ordinary: 5 }, ['x'], null])
      await expect(h.users.setUserRoles('target', { roleIds: ['ordinary'], expiries }, as('authorizer')))
        .rejects.toMatchObject({ status: 400 });
  });
});
