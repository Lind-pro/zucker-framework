/**
 * Opt-in expiring role assignments.
 *
 * With `ZuckerAuthModule.forRoot({ roleAssignments: { expiry: true } })` every read of the
 * `userRoles` link that grants authority (permissions, role dimensions, menus, hierarchy
 * expansion) ignores links whose `expiresAt` is in the past. The option is OFF by default and,
 * when off, every query is byte-for-byte what it was before: other consumers' `user_roles`
 * tables have no `expiresAt` column, so the column must never be named unless asked for.
 */

/** Public module option (`ZuckerAuthModuleOptions.roleAssignments`). */
export interface RoleAssignmentOptions {
  /** Honour `userRoles.expiresAt` (nullable `DateTime`). Requires the column. Default false. */
  expiry?: boolean;
}

/** Resolved, injectable form (token `ROLE_ASSIGNMENT_OPTIONS`). */
export interface ResolvedRoleAssignmentOptions {
  readonly expiry: boolean;
}

/** Injection token exported by `ZuckerAuthModule` (global). Value: `ResolvedRoleAssignmentOptions`. */
export const ROLE_ASSIGNMENT_OPTIONS = Symbol.for('zucker:auth:roleAssignmentOptions');

export function resolveRoleAssignmentOptions(
  options: RoleAssignmentOptions | undefined,
): ResolvedRoleAssignmentOptions {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new TypeError('[ZuckerAuthModule] roleAssignments must be an object such as { expiry: true }');
  }
  if (options?.expiry !== undefined && typeof options.expiry !== 'boolean') {
    throw new TypeError('[ZuckerAuthModule] roleAssignments.expiry must be a boolean');
  }
  return Object.freeze({ expiry: options?.expiry === true });
}

/**
 * `where` clause for the role links of one user that are in force at `now`.
 * Expiry off → exactly `{ userId }` (no reference to `expiresAt`).
 */
export function activeUserRoleWhere(
  userId: string,
  options: ResolvedRoleAssignmentOptions,
  now: Date,
): Record<string, unknown> {
  if (!options.expiry) return { userId };
  return {
    userId,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/** `select` clause matching `activeUserRoleWhere` (adds `expiresAt` only when expiry is on). */
export function activeUserRoleSelect(options: ResolvedRoleAssignmentOptions): Record<string, true> {
  return options.expiry ? { roleId: true, expiresAt: true } : { roleId: true };
}

/** Earliest future expiry (epoch ms) among loaded links, or undefined when none expires. */
export function earliestRoleExpiry(
  links: ReadonlyArray<{ expiresAt?: Date | string | null }>,
  nowMs: number,
): number | undefined {
  let earliest: number | undefined;
  for (const link of links) {
    if (link.expiresAt === null || link.expiresAt === undefined) continue;
    const at = link.expiresAt instanceof Date ? link.expiresAt.getTime() : Date.parse(link.expiresAt);
    if (!Number.isFinite(at) || at <= nowMs) continue;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}
