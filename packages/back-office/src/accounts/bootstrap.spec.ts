// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ScryptEncoder } from '@zucker-framework/auth';
import type { DatabaseAdapter } from '@zucker-framework/core';
import {
  AssignRoleError, assignRoleByEmail, createAdministrator, parseAssignRoleArguments, parseRoleExpiry, seedStarterData, syncMenus, syncPermissions,
  type MenuCatalogEntry,
} from './index';
import { PASSWORD, SpyAdapter } from './testing/account-fixture';

/** Counts every write per model so "nothing written" is asserted, not inferred from the result. */
function counting(inner = new SpyAdapter()) {
  const writes: string[] = [];
  const wrap = (db: DatabaseAdapter): DatabaseAdapter => ({
    model: (name: string) => new Proxy(db.model(name), { get: (target, key) => {
      const value = Reflect.get(target, key) as (...args: unknown[]) => unknown;
      return ['create', 'update', 'updateMany', 'delete', 'deleteMany', 'createMany'].includes(String(key))
        ? (...args: unknown[]) => { writes.push(`${name}.${String(key)}`); return value.apply(target, args); }
        : value.bind(target);
    } }),
    $transaction: <T>(work: (tx: DatabaseAdapter) => Promise<T>) => db.$transaction(tx => work(wrap(tx))),
  } as unknown as DatabaseAdapter);
  return { db: wrap(inner), writes, raw: inner };
}

const catalog: MenuCatalogEntry[] = [
  { key: 'dashboard', name: 'Dashboard', path: '/dashboard', icon: 'home' },
  { key: 'users', name: 'Users', path: '/users', permission: 'users:query', parent: 'dashboard' },
  { key: 'plans', name: 'Plans', permission: 'plans:query' },
];

describe('syncMenus', () => {
  it('creates missing rows, then a second run writes nothing', async () => {
    const { db, writes, raw } = counting();
    expect(await syncMenus(db, catalog)).toEqual({ created: 3, updated: 0, unchanged: 0 });
    expect(await raw.model('menus').findUnique({ where: { id: 'starter:users' } })).toMatchObject({
      name: 'Users', path: '/users', parentId: 'starter:dashboard', permissions: ['users:query'], sortOrder: 1, status: true });
    writes.length = 0;
    expect(await syncMenus(db, catalog)).toEqual({ created: 0, updated: 0, unchanged: 3 });
    expect(await syncMenus(db, catalog, { overwrite: true })).toEqual({ created: 0, updated: 0, unchanged: 3 });
    expect(writes).toEqual([]);
  });

  it('keeps operator edits unless overwrite is set, and then writes only what differs', async () => {
    const { db, writes, raw } = counting();
    await syncMenus(db, catalog);
    await raw.model('menus').update({ where: { id: 'starter:users' }, data: { name: 'Team' } });
    writes.length = 0;
    expect(await syncMenus(db, catalog)).toMatchObject({ updated: 0, unchanged: 3 });
    expect(writes).toEqual([]);
    expect(await syncMenus(db, catalog, { overwrite: true })).toEqual({ created: 0, updated: 1, unchanged: 2 });
    expect(writes).toEqual(['menus.update']);
    expect((await raw.model('menus').findUnique({ where: { id: 'starter:users' } }))!.name).toBe('Users');
  });

  it('uses the renamed menus model and a product id prefix; new catalog entries are created later', async () => {
    const { db, raw } = counting();
    await syncMenus(db, catalog.slice(0, 1), { idPrefix: 'cc:', models: { menus: 'app_menus' } });
    expect(await raw.model('app_menus').findUnique({ where: { id: 'cc:dashboard' } })).toBeTruthy();
    expect(await raw.model('menus').findMany({})).toEqual([]);
    expect(await syncMenus(db, catalog, { idPrefix: 'cc:', models: { menus: 'app_menus' } })).toEqual({ created: 2, updated: 0, unchanged: 1 });
  });

  it('refuses malformed prefixes, keys and dangling parents before writing anything', async () => {
    const { db, writes } = counting();
    await expect(syncMenus(db, catalog, { idPrefix: 'Bad' })).rejects.toThrow(/idPrefix/);
    await expect(syncMenus(db, [{ key: 'Bad Key', name: 'x' }])).rejects.toThrow(/invalid menu entry/);
    await expect(syncMenus(db, [{ key: 'child', name: 'x', parent: 'missing' }])).rejects.toThrow(/invalid menu entry "child"/);
    expect(writes).toEqual([]);
  });
});

describe('syncPermissions', () => {
  it('creates missing permissions once; re-running is a no-op', async () => {
    const { db, writes } = counting();
    const entries = ['users:query', { code: 'plans:update', name: 'Update plans', description: 'Edit plans' }, 'users:query'];
    expect(await syncPermissions(db, entries)).toEqual({ created: 2, updated: 0, unchanged: 0 });
    writes.length = 0;
    expect(await syncPermissions(db, entries)).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect(writes).toEqual([]);
  });

  it('updates only entries that carry a differing name or description', async () => {
    const { db, raw, writes } = counting();
    await syncPermissions(db, [{ code: 'a:b', name: 'Old' }, 'c:d'], { description: 'seeded' });
    expect((await raw.model('permissions').findUnique({ where: { id: 'c:d' } }))).toMatchObject({ name: 'c:d', description: 'seeded' });
    writes.length = 0;
    expect(await syncPermissions(db, [{ code: 'a:b', name: 'New' }, 'c:d'])).toEqual({ created: 0, updated: 1, unchanged: 1 });
    expect(writes).toEqual(['permissions.update']);
    // A plain code never rewrites an operator-edited display name.
    await raw.model('permissions').update({ where: { id: 'c:d' }, data: { name: 'Edited' } });
    expect(await syncPermissions(db, ['c:d'])).toEqual({ created: 0, updated: 0, unchanged: 1 });
  });

  it('rejects unsafe permission codes and uses the renamed model', async () => {
    const { db, writes, raw } = counting();
    await expect(syncPermissions(db, ['ok', 'bad code'])).rejects.toThrow(/invalid permission code/);
    await expect(syncPermissions(db, [{ code: 7 as never }])).rejects.toThrow(/invalid permission code/);
    expect(writes).toEqual([]); // validated before any write
    await syncPermissions(db, ['x:y'], { models: { permissions: 'app_permissions' } });
    expect(await raw.model('app_permissions').findUnique({ where: { id: 'x:y' } })).toBeTruthy();
  });
});

describe('seedStarterData and createAdministrator', () => {
  it('wraps a failing seed with its name and keeps the cause', async () => {
    const { db } = counting();
    const cause = new Error('db down');
    await expect(seedStarterData(db, [{ name: 'ok', run: async () => undefined }, { name: 'plans', run: async () => { throw cause; } }]))
      .rejects.toMatchObject({ message: 'Starter data seed plans failed', cause });
  });

  it('creates a verified superadmin once with scrypt hash, menus and permissions; a second run refuses and writes nothing', async () => {
    const { db, raw, writes } = counting();
    const seeded: string[] = [];
    const input = { username: 'owner', email: 'Owner@Example.invalid', password: PASSWORD };
    const options = { menus: catalog, permissions: ['extra:read'], passwordEncoder: new ScryptEncoder(), seeds: [{ name: 'plans', run: async () => { seeded.push('plans'); } }] };
    const id = await createAdministrator(db, input, options);
    const user = await raw.model('users').findUnique({ where: { id } });
    expect(user).toMatchObject({ username: 'owner', email: 'owner@example.invalid', emailVerified: true, status: true, typeId: 'administrator' });
    expect(user!.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    const role = await raw.model('roles').findUnique({ where: { name: 'superadmin' } });
    expect(await raw.model('userRoles').findMany({ where: { userId: id } })).toEqual([expect.objectContaining({ roleId: role!.id })]);
    expect((await raw.model('permissions').findMany({})).map(row => row.id).sort()).toEqual(['extra:read', 'plans:query', 'users:query']);
    expect(seeded).toEqual(['plans']);
    writes.length = 0;
    await expect(createAdministrator(db, input, options)).rejects.toThrow(/Account already exists/);
    expect(writes).toEqual([]);
    expect(seeded).toEqual(['plans']);
  });

  it('refuses a malformed email and leaves nothing behind when a seed fails inside the setup transaction', async () => {
    const { db, raw } = counting();
    await expect(createAdministrator(db, { username: 'x1', email: 'nope', password: PASSWORD })).rejects.toThrow(/Invalid administrator email/);
    await expect(createAdministrator(db, { username: 'x2', email: `${'a'.repeat(250)}@e.invalid`, password: PASSWORD })).rejects.toThrow(/Invalid administrator email/);
    expect(await raw.model('users').findMany({})).toEqual([]);
  });
});

describe('assignRoleByEmail', () => {
  async function owner() {
    const kit = counting();
    const userId = await createAdministrator(kit.db, { username: 'boss', email: 'boss@example.invalid', password: PASSWORD });
    await kit.raw.model('users').create({ data: { id: 'u2', username: 'member', email: 'member@example.invalid', status: true } });
    await kit.raw.model('roles').create({ data: { id: 'r-editor', name: 'editor', status: true } });
    await kit.raw.model('roles').create({ data: { id: 'r-off', name: 'retired', status: false } });
    return { ...kit, userId };
  }
  const now = new Date('2026-06-01T00:00:00Z');

  it('assigns once, audits, and is a no-op the second time', async () => {
    const { db, raw, writes } = await owner();
    const first = await assignRoleByEmail(db, { email: ' Member@example.invalid ', role: 'editor' }, now);
    expect(first).toMatchObject({ userId: 'u2', roleId: 'r-editor', roleName: 'editor', assigned: true, expiresAt: null });
    writes.length = 0;
    expect(await assignRoleByEmail(db, { email: 'member@example.invalid', role: 'r-editor' }, now)).toMatchObject({ assigned: false });
    expect(writes).toEqual([]);
    expect(await raw.model('userRoles').findMany({ where: { userId: 'u2' } })).toHaveLength(1);
    expect((await raw.model('operationLogs').findMany({})).map(row => row.action)).toEqual(['assign-role']);
  });

  it('applies and then changes an expiry, writing only when it differs', async () => {
    const { db, raw, writes } = await owner();
    const expiring = await assignRoleByEmail(db, { email: 'member@example.invalid', role: 'editor', expires: '30d' }, now);
    expect(expiring.expiresAt!.getTime()).toBe(now.getTime() + 30 * 86_400_000);
    writes.length = 0;
    expect(await assignRoleByEmail(db, { email: 'member@example.invalid', role: 'editor', expires: '30d' }, now)).toMatchObject({ assigned: false, expiresAt: expiring.expiresAt });
    expect(writes).toEqual([]);
    expect(await assignRoleByEmail(db, { email: 'member@example.invalid', role: 'editor', expires: '2027-01-01' }, now)).toMatchObject({ assigned: false, expiryUpdated: true });
    expect((await raw.model('operationLogs').findMany({})).map(row => row.action)).toEqual(['assign-role', 'assign-role-expiry']);
  });

  it('refuses unknown accounts, unknown or disabled roles, and bad input without writing', async () => {
    const { db, writes } = await owner();
    writes.length = 0;
    await expect(assignRoleByEmail(db, { email: 'ghost@example.invalid', role: 'editor' }, now)).rejects.toThrow(/No account uses this email/);
    await expect(assignRoleByEmail(db, { email: 'member@example.invalid', role: 'ghost' }, now)).rejects.toThrow(/Unknown role/);
    await expect(assignRoleByEmail(db, { email: 'member@example.invalid', role: 'retired' }, now)).rejects.toThrow(/Role is disabled/);
    await expect(assignRoleByEmail(db, { email: 'not-an-email', role: 'editor' }, now)).rejects.toBeInstanceOf(AssignRoleError);
    await expect(assignRoleByEmail(db, { email: 'member@example.invalid', role: 'ed\u0000itor' }, now)).rejects.toBeInstanceOf(AssignRoleError);
    expect(writes).toEqual([]);
  });
});

describe('role CLI parsing', () => {
  it('parseRoleExpiry: days, ISO dates, and rejects the past, zero and garbage', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(parseRoleExpiry('1d', now).getTime()).toBe(now.getTime() + 86_400_000);
    expect(parseRoleExpiry('3650d', now)).toBeInstanceOf(Date);
    expect(parseRoleExpiry('2026-12-31', now).toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(parseRoleExpiry('2026-12-31T12:00:00Z', now).toISOString()).toBe('2026-12-31T12:00:00.000Z');
    for (const bad of ['0d', '3651d', '2026-05-01', 'tomorrow', '', '12', '2026-13-45', '30 days']) expect(() => parseRoleExpiry(bad, now), bad).toThrow(AssignRoleError);
  });

  it('parseAssignRoleArguments: flags with = or a following value; anything else is refused', () => {
    expect(parseAssignRoleArguments(['--email', 'a@b.invalid', '--role=editor'])).toEqual({ email: 'a@b.invalid', role: 'editor' });
    expect(parseAssignRoleArguments(['--', '--email=a@b.invalid', '--role', 'r', '--expires', '7d'])).toEqual({ email: 'a@b.invalid', role: 'r', expires: '7d' });
    expect(() => parseAssignRoleArguments(['--email', 'a@b.invalid'])).toThrow(/Usage/);
    expect(() => parseAssignRoleArguments(['--email', 'a', '--email', 'b', '--role', 'r'])).toThrow(/Duplicate --email/);
    expect(() => parseAssignRoleArguments(['--email', '--role', 'r'])).toThrow(/Missing value for --email/);
    expect(() => parseAssignRoleArguments(['--email', 'a', '--role', 'r', '--force'])).toThrow(/Unknown argument/);
    expect(() => parseAssignRoleArguments(['--email', 'a', '--role', 'r', '--expires', 'soon'])).toThrow(AssignRoleError);
    expect(() => parseAssignRoleArguments([], 'custom usage')).toThrow('custom usage');
  });
});
