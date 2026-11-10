import 'dotenv/config';
import { ApplicationDatabase } from '../database';
import { AssignRoleError, assignRoleByEmail, parseAssignRoleArguments } from './assign-role';

/** `pnpm account:role -- --email <address> --role <name-or-id>` */
async function main() {
  const input = parseAssignRoleArguments(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new AssignRoleError('Provide DATABASE_URL in private configuration.');
  const db = new ApplicationDatabase(process.env.DATABASE_URL);
  try {
    const result = await assignRoleByEmail(db, input);
    process.stdout.write(result.assigned ? `Role ${result.roleName} assigned.\n` : `The account already has role ${result.roleName}.\n`);
  } finally { await db.disconnect(); }
}
main().catch(error => {
  // Known refusals are safe to print; anything else may carry connection details.
  process.stderr.write(error instanceof AssignRoleError ? `${error.message}\n` : 'Role assignment failed; verify DATABASE_URL and the migrations.\n');
  process.exitCode = 1;
});
