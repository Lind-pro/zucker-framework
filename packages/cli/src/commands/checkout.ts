import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

function packageName(manifest: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Root of a zucker-framework source checkout when this CLI runs from `<root>/packages/cli/dist`,
 * otherwise `null`. An installed CLI (`node_modules/@zucker-framework/cli/dist`) never qualifies, so
 * a stray `node_modules/templates` or `node_modules/packages` package can never be used as a source.
 */
export function frameworkCheckoutRoot(runtimeDirectory: string): string | null {
  let runtime: string;
  try {
    runtime = realpathSync(runtimeDirectory);
  } catch {
    return null;
  }
  const cliDir = dirname(runtime);
  const packagesDir = dirname(cliDir);
  if (basename(runtime) !== 'dist' || basename(cliDir) !== 'cli' || basename(packagesDir) !== 'packages') return null;
  const root = resolve(packagesDir, '..');
  if (!existsSync(join(root, 'pnpm-workspace.yaml'))) return null;
  if (packageName(join(cliDir, 'package.json')) !== '@zucker-framework/cli') return null;
  return root;
}
