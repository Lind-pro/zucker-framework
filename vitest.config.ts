import { defineConfig } from 'vitest/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(rootDir, 'packages');

const workspaceAliases = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const packageDir = resolve(packagesDir, entry.name);
    const manifestPath = resolve(packageDir, 'package.json');
    const sourceEntry = resolve(packageDir, 'src/index.ts');
    if (!existsSync(manifestPath) || !existsSync(sourceEntry)) return [];

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
    };
    if (!manifest.name) return [];

    const escapedName = manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [{ find: new RegExp(`^${escapedName}$`), replacement: sourceEntry }];
  });

export default defineConfig({
  resolve: {
    // Unit tests consume workspace source, never stale or missing dist output.
    alias: workspaceAliases,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['packages/*/src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
