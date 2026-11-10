import type { DatabaseAdapter } from '@zucker-framework/core';
import type { PermissionService } from '@zucker-framework/auth';

/** Permission codes that make the holder a superadmin (see PermissionService.hasPermission). */
export const isPrivilegedCode = (code: string): boolean => code === 'superadmin' || code === '*';

/** Whether the user currently holds superadmin or the `*` wildcard. */
export async function isSuperadminUser(permissions: PermissionService, userId: string): Promise<boolean> {
  const codes = await permissions.findUserPermissions(userId);
  return codes.includes('superadmin') || codes.includes('*');
}

/**
 * Privileged codes the given roles confer, mirroring how PermissionService expands them: a role
 * named `superadmin` (directly or through a `parentId` ancestor) yields `superadmin`, and role
 * permission links to `superadmin` or `*` are reported as well. Reads through `db`, so callers
 * pass their transaction after pinning the roles to check what will be committed.
 */
export async function privilegedRoleCodes(db: DatabaseAdapter, roleIds: readonly string[]): Promise<string[]> {
  const codes = new Set<string>();
  const seen = new Set<string>();
  let frontier = [...new Set(roleIds)];
  // Bounded walk up the role tree; cycles stop at `seen`.
  for (let depth = 0; frontier.length && depth < 64; depth++) {
    frontier.forEach(roleId => seen.add(roleId));
    const roles = await db.model('roles').findMany({ where: { id: { in: frontier } } }) as Array<{ name?: unknown; parentId?: unknown }>;
    for (const role of roles) if (role.name === 'superadmin') codes.add('superadmin');
    frontier = [...new Set(roles.map(role => role.parentId)
      .filter((parentId): parentId is string => typeof parentId === 'string' && !!parentId && !seen.has(parentId)))];
  }
  if (seen.size) {
    const links = await db.model('rolePermissions').findMany({ where: { roleId: { in: [...seen] } } }) as Array<{ permissionId?: unknown }>;
    for (const link of links) if (typeof link.permissionId === 'string' && isPrivilegedCode(link.permissionId)) codes.add(link.permissionId);
  }
  return [...codes];
}
