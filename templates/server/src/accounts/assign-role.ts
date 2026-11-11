import type { DatabaseAdapter } from '@zucker-framework/core';

export class AssignRoleError extends Error {}
export interface AssignRoleResult {
  userId: string; roleId: string; roleName: string; assigned: boolean;
  /** End of the assignment (null = never expires). */
  expiresAt: Date | null;
  /** An existing assignment whose expiry was changed by `--expires`. */
  expiryUpdated?: boolean;
}
export interface AssignRoleInput { email: string; role: string; expires?: string }

const DAY_MS = 86_400_000;
/**
 * `--expires` value: an ISO 8601 date/time in the future, or `<N>d` (1–3650 days from `now`).
 * The sign-up `initialRoleId` never expires; only this owner command (and the back office) set an end.
 */
export function parseRoleExpiry(value: string, now = new Date()): Date {
  const trimmed = value.trim();
  const days = /^(\d{1,4})d$/i.exec(trimmed);
  if (days) {
    const count = Number(days[1]);
    if (count < 1 || count > 3650) throw new AssignRoleError('--expires days must be between 1 and 3650');
    return new Date(now.getTime() + count * DAY_MS);
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
    throw new AssignRoleError('--expires must be an ISO date (2026-12-31 or 2026-12-31T12:00:00Z) or a number of days (30d)');
  }
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) throw new AssignRoleError('--expires is not a valid date');
  if (date.getTime() <= now.getTime()) throw new AssignRoleError('--expires must be in the future');
  return date;
}

/**
 * Explicit owner command (`pnpm account:role -- --email <address> --role <name-or-id> [--expires 30d]`); never
 * reachable from HTTP. Grants an existing, enabled role to an existing account found by e-mail.
 * Unknown accounts and roles are refused (roles are never created here); an existing assignment is
 * left as it is (`assigned: false`). The account's open sessions keep working and see the new
 * permissions on their next permission read. Each change is audited in `operationLogs`.
 */
export async function assignRoleByEmail(db: DatabaseAdapter, input: AssignRoleInput, now = new Date()): Promise<AssignRoleResult> {
  const email = input.email.trim().toLowerCase(), role = input.role.trim();
  const expiresAt = input.expires === undefined ? null : parseRoleExpiry(input.expires, now);
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AssignRoleError('Invalid email');
  if (!role || role.length > 191 || /[\u0000-\u001f\u007f]/.test(role)) throw new AssignRoleError('Invalid role');
  return db.$transaction(async tx => {
    const user = await tx.model('users').findUnique({ where: { email }, select: { id: true } }) as { id: string } | null;
    if (!user) throw new AssignRoleError('No account uses this email');
    const found = (await tx.model('roles').findUnique({ where: { name: role }, select: { id: true, name: true, status: true } })
      ?? await tx.model('roles').findUnique({ where: { id: role }, select: { id: true, name: true, status: true } })) as
      { id: string; name: string; status: boolean | null } | null;
    if (!found) throw new AssignRoleError('Unknown role; create it in the back office first');
    if (found.status === false) throw new AssignRoleError('Role is disabled');
    const existing = await tx.model('userRoles').findUnique({ where: { userId_roleId: { userId: user.id, roleId: found.id } } }) as
      { id: string; expiresAt: Date | null } | null;
    const audit = (action: string) => tx.model('operationLogs').create({ data: { module: 'accounts', action, status: 'SUCCESS',
      targetId: user.id, targetType: 'account', metadata: { roleId: found.id, roleName: found.name, via: 'cli',
        expiresAt: expiresAt ? expiresAt.toISOString() : null } } });
    if (existing) {
      // Without --expires an existing assignment is left as it is; with it, the explicit end replaces the old one.
      if (!expiresAt || existing.expiresAt?.getTime() === expiresAt.getTime()) {
        return { userId: user.id, roleId: found.id, roleName: found.name, assigned: false, expiresAt: existing.expiresAt ?? null };
      }
      await tx.model('userRoles').update({ where: { id: existing.id }, data: { expiresAt } });
      await audit('assign-role-expiry');
      return { userId: user.id, roleId: found.id, roleName: found.name, assigned: false, expiresAt, expiryUpdated: true };
    }
    await tx.model('userRoles').create({ data: { userId: user.id, roleId: found.id, expiresAt } });
    await audit('assign-role');
    return { userId: user.id, roleId: found.id, roleName: found.name, assigned: true, expiresAt };
  });
}

/** Parses `--email <value> --role <value> [--expires <ISO date | Nd>]` (also `--name=<value>`); anything else is refused. */
export function parseAssignRoleArguments(argv: readonly string[]): AssignRoleInput {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--') continue;
    const match = /^--(email|role|expires)(?:=(.*))?$/.exec(argument);
    if (!match) throw new AssignRoleError(`Unknown argument ${argument.slice(0, 40)}`);
    const value = match[2] ?? argv[++index];
    if (value === undefined || value.startsWith('--')) throw new AssignRoleError(`Missing value for --${match[1]}`);
    if (Object.hasOwn(values, match[1]!)) throw new AssignRoleError(`Duplicate --${match[1]}`);
    values[match[1]!] = value;
  }
  if (!values.email || !values.role) throw new AssignRoleError('Usage: pnpm account:role -- --email <address> --role <name-or-id> [--expires <ISO date | Nd>]');
  if (values.expires !== undefined) parseRoleExpiry(values.expires);
  return { email: values.email, role: values.role, ...(values.expires !== undefined ? { expires: values.expires } : {}) };
}
