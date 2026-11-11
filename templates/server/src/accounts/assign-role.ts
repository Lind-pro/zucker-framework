import { parseAssignRoleArguments as parse, type AssignRoleInput } from '@zucker-framework/back-office/accounts';

export { AssignRoleError, assignRoleByEmail, parseRoleExpiry, type AssignRoleInput, type AssignRoleResult } from '@zucker-framework/back-office/accounts';

/** `pnpm account:role -- --email <address> --role <name-or-id> [--expires <ISO date | Nd>]` */
export function parseAssignRoleArguments(argv: readonly string[]): AssignRoleInput {
  return parse(argv, 'Usage: pnpm account:role -- --email <address> --role <name-or-id> [--expires <ISO date | Nd>]');
}
