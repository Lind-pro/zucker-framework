import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from './permission.service';
import { activeUserRoleWhere, resolveRoleAssignmentOptions } from './role-assignments';

type Row = Record<string, unknown>;

/** Minimal adapter: records userRoles queries and evaluates the expiry filter itself. */
function fakeDb(userRoles: Array<{ roleId: string; expiresAt?: Date | null }>) {
  const userRoleQueries: Row[] = [];
  const roles = [{ id: 'r1', name: 'editor' }, { id: 'r2', name: 'viewer' }];
  const db = {
    model(name: string) {
      return {
        findMany: vi.fn(async (args: { where: Row; select?: Row }) => {
          if (name === 'userRoles') {
            userRoleQueries.push(args);
            const where = args.where as { OR?: Array<{ expiresAt: null | { gt: Date } }> };
            const gt = where.OR?.find((c) => c.expiresAt !== null)?.expiresAt as { gt: Date } | undefined;
            return userRoles
              .filter((row) => !gt || row.expiresAt == null || row.expiresAt > gt.gt)
              .map((row) => (args.select && 'expiresAt' in args.select ? row : { roleId: row.roleId }));
          }
          if (name === 'roles') {
            const ids = ((args.where as { id: { in: string[] } }).id.in);
            return roles.filter((role) => ids.includes(role.id));
          }
          return [];
        }),
      };
    },
  };
  return { db, userRoleQueries };
}

describe('role expiry (opt-in)', () => {
  it('off: issues exactly the previous query', async () => {
    const { db, userRoleQueries } = fakeDb([{ roleId: 'r1' }]);
    const service = new PermissionService(db as never);
    await service.findUserPermissions('u1');
    await service.hasDimension('u1', 'role', ['editor']);
    expect(userRoleQueries).toEqual([
      { where: { userId: 'u1' }, select: { roleId: true } },
      { where: { userId: 'u1' }, select: { roleId: true } },
    ]);
    expect(activeUserRoleWhere('u1', resolveRoleAssignmentOptions(undefined), new Date())).toEqual({ userId: 'u1' });
  });

  it('on: expired links grant nothing and the cache never outlives the earliest expiry', async () => {
    let now = Date.parse('2026-11-10T00:00:00Z');
    const { db, userRoleQueries } = fakeDb([
      { roleId: 'r1', expiresAt: new Date(now + 2_000) },
      { roleId: 'r2', expiresAt: new Date(now - 1) },
    ]);
    const service = new PermissionService(db as never);
    service.configureRoleAssignments({ expiry: true }, () => now);

    expect(await service.findUserPermissions('u1')).toEqual(['role:editor']);
    expect(userRoleQueries[0]).toEqual({
      where: { userId: 'u1', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }] },
      select: { roleId: true, expiresAt: true },
    });
    now += 1_999;
    expect(await service.findUserPermissions('u1')).toEqual(['role:editor']);
    expect(userRoleQueries).toHaveLength(1);
    now += 1; // reaches expiresAt, well inside the 5 s TTL
    expect(await service.findUserPermissions('u1')).toEqual([]);
    expect(await service.hasDimension('u1', 'role', ['editor'])).toBe(false);
  });

  it('rejects a malformed option', () => {
    expect(() => resolveRoleAssignmentOptions({ expiry: 'yes' as never })).toThrow(TypeError);
  });
});
