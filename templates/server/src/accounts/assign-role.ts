import type { DatabaseAdapter } from '@zucker-framework/core';

export class AssignRoleError extends Error {}
export interface AssignRoleResult { userId: string; roleId: string; roleName: string; assigned: boolean }

/**
 * Explicit owner command (`pnpm account:role -- --email <address> --role <name-or-id>`); never
 * reachable from HTTP. Grants an existing, enabled role to an existing account found by e-mail.
 * Unknown accounts and roles are refused (roles are never created here); an existing assignment is
 * left as it is (`assigned: false`). The account's open sessions keep working and see the new
 * permissions on their next permission read. Each change is audited in `operationLogs`.
 */
export async function assignRoleByEmail(db: DatabaseAdapter, input: { email: string; role: string }): Promise<AssignRoleResult> {
  const email = input.email.trim().toLowerCase(), role = input.role.trim();
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
    const existing = await tx.model('userRoles').findUnique({ where: { userId_roleId: { userId: user.id, roleId: found.id } } });
    if (existing) return { userId: user.id, roleId: found.id, roleName: found.name, assigned: false };
    await tx.model('userRoles').create({ data: { userId: user.id, roleId: found.id } });
    await tx.model('operationLogs').create({ data: { module: 'accounts', action: 'assign-role', status: 'SUCCESS',
      targetId: user.id, targetType: 'account', metadata: { roleId: found.id, roleName: found.name, via: 'cli' } } });
    return { userId: user.id, roleId: found.id, roleName: found.name, assigned: true };
  });
}

/** Parses `--email <value> --role <value>` (also `--email=<value>`); anything else is refused. */
export function parseAssignRoleArguments(argv: readonly string[]): { email: string; role: string } {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--') continue;
    const match = /^--(email|role)(?:=(.*))?$/.exec(argument);
    if (!match) throw new AssignRoleError(`Unknown argument ${argument.slice(0, 40)}`);
    const value = match[2] ?? argv[++index];
    if (value === undefined || value.startsWith('--')) throw new AssignRoleError(`Missing value for --${match[1]}`);
    values[match[1]!] = value;
  }
  if (!values.email || !values.role) throw new AssignRoleError('Usage: pnpm account:role -- --email <address> --role <name-or-id>');
  return { email: values.email, role: values.role };
}
