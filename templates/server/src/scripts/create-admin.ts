import 'dotenv/config';
import { ApplicationDatabase } from '../database';
import { createAdministrator, STARTER_DATA_SEEDS } from '../accounts/create-administrator';
import { readBillingCatalog } from '../billing/catalog';
import { creditPackSeedsFromBillingCatalog, creditPackStarterSeed } from '../billing/credit-pack-seeds';
import { contentOptionsFromEnvironment } from '../content/content.options';
import { contentStarterSeed } from '../content/content-seed';
import { planSeedsFromBillingCatalog } from '../subscriptions/plan-seeds';

async function main() {
  const { DATABASE_URL, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD } = process.env;
  if (!DATABASE_URL || !BOOTSTRAP_ADMIN_USERNAME || !BOOTSTRAP_ADMIN_EMAIL || !BOOTSTRAP_ADMIN_PASSWORD) {
    throw new Error('Provide DATABASE_URL and explicit BOOTSTRAP_ADMIN_USERNAME/EMAIL/PASSWORD in private configuration.');
  }
  const db = new ApplicationDatabase(DATABASE_URL);
  try {
    // BILLING_CATALOG_JSON subscription offers seed the plan table once and its one-time offers the credit
    // packs once; later edits live in the database. The starter CMS documents in content/ are published
    // into the CMS (existing entries untouched) so administrators can edit them.
    const catalog = readBillingCatalog(process.env.BILLING_CATALOG_JSON);
    const contentDirectory = contentOptionsFromEnvironment(process.env).contentDirectory;
    await createAdministrator(db, { username: BOOTSTRAP_ADMIN_USERNAME, password: BOOTSTRAP_ADMIN_PASSWORD, email: BOOTSTRAP_ADMIN_EMAIL },
      { plans: planSeedsFromBillingCatalog(catalog), seeds: [...STARTER_DATA_SEEDS,
        creditPackStarterSeed(creditPackSeedsFromBillingCatalog(catalog)),
        ...(contentDirectory ? [contentStarterSeed({ directory: contentDirectory, publish: true })] : [])] });
    process.stdout.write('Administrator created. Remove the bootstrap password from local configuration.\n');
  } finally { await db.disconnect(); }
}
main().catch(() => { process.stderr.write('Administrator setup failed; verify required configuration, account uniqueness and password policy.\n'); process.exitCode = 1; });
