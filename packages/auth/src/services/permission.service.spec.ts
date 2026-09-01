import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryAdapter } from '@zucker/crud';
import { PermissionService } from './permission.service';

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

describe('PermissionService', () => {
  let db: InMemoryAdapter;
  let service: PermissionService;

  beforeEach(async () => {
    db = new InMemoryAdapter();
    service = new PermissionService(db as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── findUserPermissions ───────────────────────────────────────────

  it('findUserPermissions loads from userRoles + userPermissions', async () => {
    // Seed role
    await db.model('roles').create({ data: { id: 'r1', name: 'editor' } });
    // Assign user to role
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r1' } });
    // Assign direct permission (composite format)
    await db.model('userPermissions').create({ data: { id: 'up1', userId: 'u1', permissionId: 'article:read' } });
    // Assign role permission (composite format)
    await db.model('rolePermissions').create({ data: { id: 'rp1', roleId: 'r1', permissionId: 'article:write' } });

    const perms = await service.findUserPermissions('u1');

    // Should contain role:<name>, composite permissions from both sources
    expect(perms).toContain('role:editor');
    expect(perms).toContain('article:read');
    expect(perms).toContain('article:write');
  });

  it('findUserPermissions: superadmin role auto-grants * permission', async () => {
    await db.model('roles').create({ data: { id: 'r-sa', name: 'superadmin' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r-sa' } });

    const perms = await service.findUserPermissions('u1');

    expect(perms).toContain('*');
    expect(perms).toContain('superadmin');
    expect(perms).toContain('role:superadmin');
  });

  it('findUserPermissions: caches results within 5s TTL', async () => {
    await db.model('roles').create({ data: { id: 'r1', name: 'viewer' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r1' } });

    const spy = vi.spyOn(db, 'model');

    // First call — hits DB
    const perms1 = await service.findUserPermissions('u1');
    const callCount1 = spy.mock.calls.length;

    // Second call — should be cached, no new DB calls
    const perms2 = await service.findUserPermissions('u1');
    const callCount2 = spy.mock.calls.length;

    expect(perms1).toEqual(perms2);
    expect(callCount2).toBe(callCount1); // no additional db.model() calls
  });

  it('findUserPermissions: cache expires after TTL', async () => {
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r1' } });
    await db.model('roles').create({ data: { id: 'r1', name: 'viewer' } });

    // First call — populates cache
    await service.findUserPermissions('u1');

    // Fast-forward time beyond TTL (5000ms)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6000);

    const spy = vi.spyOn(db, 'model');
    // Should hit DB again after TTL expiry
    await service.findUserPermissions('u1');
    expect(spy).toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ─── invalidatePermissionCache ─────────────────────────────────────

  it('invalidatePermissionCache: clears specific user cache', async () => {
    // Seed minimal data
    await db.model('roles').create({ data: { id: 'r1', name: 'user' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r1' } });
    await db.model('userRoles').create({ data: { id: 'ur2', userId: 'u2', roleId: 'r1' } });

    // Populate cache for both users
    await service.findUserPermissions('u1');
    await service.findUserPermissions('u2');

    const spy = vi.spyOn(db, 'model');

    // Invalidate only u1
    service.invalidatePermissionCache('u1');

    // u1 should re-query
    await service.findUserPermissions('u1');
    const u1Calls = spy.mock.calls.length;
    expect(u1Calls).toBeGreaterThan(0);

    spy.mockClear();
    // u2 should still be cached
    await service.findUserPermissions('u2');
    expect(spy).not.toHaveBeenCalled();
  });

  it('invalidatePermissionCache: clears all users when no userId', async () => {
    await db.model('roles').create({ data: { id: 'r1', name: 'user' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r1' } });
    await db.model('userRoles').create({ data: { id: 'ur2', userId: 'u2', roleId: 'r1' } });

    await service.findUserPermissions('u1');
    await service.findUserPermissions('u2');

    service.invalidatePermissionCache(); // clear all

    const spy = vi.spyOn(db, 'model');

    await service.findUserPermissions('u1');
    expect(spy.mock.calls.length).toBeGreaterThan(0);

    spy.mockClear();
    await service.findUserPermissions('u2');
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  // ─── hasPermission ─────────────────────────────────────────────────

  it('hasPermission: empty required permissions returns true', async () => {
    expect(await service.hasPermission('u1', [])).toBe(true);
  });

  it('hasPermission: wildcard match (resource:*)', async () => {
    // User has user:read and user:write via role permissions
    await db.model('roles').create({ data: { id: 'r1', name: 'user-mgr' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r1' } });
    await db.model('rolePermissions').create({ data: { id: 'rp1', roleId: 'r1', permissionId: 'user:read' } });
    await db.model('rolePermissions').create({ data: { id: 'rp2', roleId: 'r1', permissionId: 'user:write' } });

    // Required permission uses wildcard — should match because user has user:read
    expect(await service.hasPermission('u1', ['user:*'])).toBe(true);
  });

  it('hasPermission: resource-level wildcard in user permissions matches any action', async () => {
    // User has user:* as a composite permission
    await db.model('userPermissions').create({ data: { id: 'up1', userId: 'u1', permissionId: 'user:*' } });

    // Required is a specific action under user
    expect(await service.hasPermission('u1', ['user:delete'])).toBe(true);
  });

  it('hasPermission: returns false when user lacks the permission', async () => {
    // User has no roles and no permissions

    expect(await service.hasPermission('u1', ['admin:manage'])).toBe(false);
  });

  it('hasPermission: superadmin bypasses all checks', async () => {
    await db.model('roles').create({ data: { id: 'r-sa', name: 'superadmin' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r-sa' } });

    expect(await service.hasPermission('u1', ['anything:here'])).toBe(true);
  });

  // ─── hasDimension ──────────────────────────────────────────────────

  it('hasDimension: empty dimensionIds returns true', async () => {
    expect(await service.hasDimension('u1', 'role', [])).toBe(true);
  });

  it('hasDimension: role type checks user roles by name (OR)', async () => {
    await db.model('roles').create({ data: { id: 'r1', name: 'editor' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r1' } });

    // User has editor role, check for editor OR admin
    expect(await service.hasDimension('u1', 'role', ['editor', 'admin'], 'OR')).toBe(true);
  });

  it('hasDimension: role type AND logic requires all roles', async () => {
    await db.model('roles').create({ data: { id: 'r1', name: 'editor' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r1' } });

    // User only has editor, check for editor AND admin
    expect(await service.hasDimension('u1', 'role', ['editor', 'admin'], 'AND')).toBe(false);
  });

  it('hasDimension: superadmin bypasses dimension check', async () => {
    await db.model('roles').create({ data: { id: 'r-sa', name: 'superadmin' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r-sa' } });

    expect(await service.hasDimension('u1', 'role', ['nonexistent'])).toBe(true);
  });

  it('hasDimension: generic dimension type (department)', async () => {
    await db.model('userDimensions').create({ data: { id: 'ud1', userId: 'u1', dimensionType: 'department', dimensionId: 'dept-eng' } });

    expect(await service.hasDimension('u1', 'department', ['dept-eng'])).toBe(true);
    expect(await service.hasDimension('u1', 'department', ['dept-hr'])).toBe(false);
  });

  // ─── hasResourceActions ────────────────────────────────────────────

  it('hasResourceActions: superadmin returns true', async () => {
    await db.model('roles').create({ data: { id: 'r-sa', name: 'superadmin' } });
    await db.model('userRoles').create({ data: { id: 'ur1', userId: 'u1', roleId: 'r-sa' } });

    expect(await service.hasResourceActions('u1', 'user', ['read', 'write'])).toBe(true);
  });

  it('hasResourceActions: resource-level wildcard grants all actions', async () => {
    await db.model('userPermissions').create({ data: { id: 'up1', userId: 'u1', permissionId: 'user:*' } });

    expect(await service.hasResourceActions('u1', 'user', ['read', 'write', 'delete'])).toBe(true);
  });

  it('hasResourceActions: checks every action is present', async () => {
    await db.model('userPermissions').create({ data: { id: 'up1', userId: 'u1', permissionId: 'user:read' } });
    await db.model('userPermissions').create({ data: { id: 'up2', userId: 'u1', permissionId: 'user:write' } });

    // Has read+write but not delete
    expect(await service.hasResourceActions('u1', 'user', ['read', 'write'])).toBe(true);
    expect(await service.hasResourceActions('u1', 'user', ['read', 'delete'])).toBe(false);
  });

  it('hasResourceActions: empty actions checks resource existence', async () => {
    await db.model('userPermissions').create({ data: { id: 'up1', userId: 'u1', permissionId: 'user:read' } });

    // Empty actions — just checks user has any permission starting with "user:"
    expect(await service.hasResourceActions('u1', 'user', [])).toBe(true);
    expect(await service.hasResourceActions('u1', 'order', [])).toBe(false);
  });

  it('hasResourceActions: resource-level permission (permission object with actions)', async () => {
    // Seed a permission object with actions array
    await db.model('permissions').create({
      data: { id: 'article', name: 'Article Management', status: true, actions: [{ action: 'read' }, { action: 'write' }] },
    });
    // Assign as resource-level permission (no colon in id)
    await db.model('userPermissions').create({ data: { id: 'up1', userId: 'u1', permissionId: 'article' } });

    const perms = await service.findUserPermissions('u1');
    expect(perms).toContain('article:read');
    expect(perms).toContain('article:write');

    expect(await service.hasResourceActions('u1', 'article', ['read'])).toBe(true);
    expect(await service.hasResourceActions('u1', 'article', ['read', 'write'])).toBe(true);
    expect(await service.hasResourceActions('u1', 'article', ['delete'])).toBe(false);
  });
});
