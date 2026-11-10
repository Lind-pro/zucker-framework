import 'dotenv/config';
import { ApplicationDatabase } from '../database';
import { createAdministrator } from '../accounts/create-administrator';
import { readBillingCatalog } from '../billing/catalog';
import { planSeedsFromBillingCatalog } from '../subscriptions/plan-seeds';

async function main() {
  const { DATABASE_URL, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD } = process.env;
  if (!DATABASE_URL || !BOOTSTRAP_ADMIN_USERNAME || !BOOTSTRAP_ADMIN_EMAIL || !BOOTSTRAP_ADMIN_PASSWORD) {
    throw new Error('Provide DATABASE_URL and explicit BOOTSTRAP_ADMIN_USERNAME/EMAIL/PASSWORD in private configuration.');
  }
  const db = new ApplicationDatabase(DATABASE_URL);
  try {
    // BILLING_CATALOG_JSON subscription offers seed the plan table once; later edits live in the database.
    await createAdministrator(db, { username: BOOTSTRAP_ADMIN_USERNAME, password: BOOTSTRAP_ADMIN_PASSWORD, email: BOOTSTRAP_ADMIN_EMAIL },
      { plans: planSeedsFromBillingCatalog(readBillingCatalog(process.env.BILLING_CATALOG_JSON)) });
    process.stdout.write('Administrator created. Remove the bootstrap password from local configuration.\n');
  } finally { await db.disconnect(); }
}
main().catch(() => { process.stderr.write('Administrator setup failed; verify required configuration, account uniqueness and password policy.\n'); process.exitCode = 1; });
