#!/usr/bin/env node
/**
 * `pnpm create @zucker-framework/app <name> [--locale en|zh] [--no-admin] [--no-web]`
 *
 * A thin entry point: the generator, its templates and the released version catalog live in
 * @zucker-framework/cli (`zucker create`), pinned to the same fixed release as this package.
 */
import { runCreate } from '@zucker-framework/cli/create';

runCreate(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
