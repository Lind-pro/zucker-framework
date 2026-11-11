import { checkContentDirectory, formatContentCheck } from './content-check';

/**
 * `pnpm content:check [directory]`: validate content/ files (pages, posts, docs, changelog) without a
 * database. Directory: the argument, else CONTENT_DIR, else `content`. Exit code 1 on any issue.
 */
async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  if (args.length > 1 || args.some(arg => arg.startsWith('-'))) throw new Error('usage: content:check [directory]');
  const report = await checkContentDirectory(args[0] ?? (process.env.CONTENT_DIR?.trim() || 'content'));
  const lines = formatContentCheck(report);
  for (const line of lines.slice(0, -1)) process.stderr.write(`${line}\n`);
  process.stdout.write(`${lines.at(-1)}\n`);
  if (report.issues.length) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`Content check failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
