import 'dotenv/config';
import { ApplicationDatabase } from '../database';
import { contentOptionsFromEnvironment } from './content.options';
import { seedContentFromFiles } from './content-seed';

/** `pnpm content:seed [--publish]`: copy content/ documents into the CMS (existing entries untouched). */
async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  const unknown = args.filter(arg => arg !== '--publish');
  if (unknown.length) throw new Error(`Unknown option ${unknown[0]}; usage: content:seed [--publish]`);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const directory = contentOptionsFromEnvironment(process.env).contentDirectory;
  if (!directory) throw new Error('No content directory configured');
  const database = new ApplicationDatabase(process.env.DATABASE_URL);
  try {
    const report = await seedContentFromFiles(database, { directory, publish: args.includes('--publish') });
    for (const item of report.created) process.stdout.write(`created ${item.status} ${item.kind} ${item.locale}/${item.slug}\n`);
    for (const item of report.skipped) process.stdout.write(`skipped ${item.kind} ${item.locale}/${item.slug} (already present)\n`);
    for (const issue of report.issues) process.stderr.write(`invalid ${issue.source}: ${issue.message}\n`);
    process.stdout.write(`Content seed finished: ${report.created.length} created, ${report.skipped.length} skipped, ${report.issues.length} invalid.\n`);
    if (report.issues.length) process.exitCode = 1;
  } finally { await database.disconnect(); }
}
main().catch(error => { process.stderr.write(`Content seed failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
