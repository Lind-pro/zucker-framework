// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInitCommand } from './init';
import { collectTemplateAssets, validateTemplateAssets, type ProjectBundle } from '../../tooling/project-templates.mjs';

let root: string;
let runtime: string;
const manifest = { name: 'template', dependencies: { '@zucker-framework/fe-auth': 'workspace:*' } };
const encode = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const templates = (): ProjectBundle => ({ version: 1, consumerInstructions: '# Consumer\nUse public packages.\n', templates: {
  admin: { 'package.json': encode(manifest), 'src/main.tsx': encode('export const example = true;\n'), '.env.example': encode('API_PROXY_TARGET=http://localhost:4200\n'), 'index.html': encode('<html/>'), 'vite.config.ts': encode('export default {};'), 'tsconfig.json': encode('{}') },
  'server-full': { ...Object.fromEntries(['README.md', '.env.example', '.gitignore', 'nest-cli.json', 'tsconfig.json', 'eslint.config.cjs', 'prisma.config.ts', 'prisma/schema.prisma', 'prisma/migrations/migration_lock.toml', 'prisma/migrations/20261024000000_initial/migration.sql', 'prisma/migrations/20261024000100_credential_version/migration.sql', 'src/main.ts', 'src/app.module.ts', 'src/database.ts', 'src/accounts/account.module.ts', 'src/accounts/account.controller.ts', 'src/accounts/account.guard.ts', 'src/accounts/account.service.ts', 'src/accounts/account-mailer.ts', 'src/accounts/create-administrator.ts', 'src/scripts/create-admin.ts'].map(path => [path, encode(`Synthetic full Server ${path}\n`)])), 'package.json': encode({ name: 'full-server', dependencies: { '@zucker-framework/auth': 'workspace:*' }, devDependencies: { '@zucker-framework/core': 'workspace:*' }, peerDependencies: { '@zucker-framework/event': 'workspace:*' }, optionalDependencies: { '@zucker-framework/storage': 'workspace:*' } }) },
  web: { 'package.json': encode(manifest), 'src/app/[locale]/(home)/page.tsx': encode('export default function Page() { return null; }\n'), 'src/app/[locale]/layout.tsx': encode('export default function Layout() { return null; }\n'), 'next.config.ts': encode('export default {};'), 'tsconfig.json': encode('{}') },
} });
const run = (name: string, template: string) => createInitCommand(runtime, root).parseAsync([name, '--template', template], { from: 'user' });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zucker-init-'));
  runtime = join(root, 'installed', 'cli', 'dist');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'release-catalog.json'), JSON.stringify({
    versions: { '@zucker-framework/fe-auth': '1.0.2', '@zucker-framework/auth': '1.0.8', '@zucker-framework/core': '1.0.8', '@zucker-framework/event': '1.0.8', '@zucker-framework/storage': '1.0.8' },
    runtime: { node: '>=22.22.0', packageManager: 'pnpm@11.25.0' },
    server: { dependencies: {}, devDependencies: {} },
  }));
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(templates()));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each(['admin', 'web'])('creates a standalone %s from its bundled assets and installs consumer instructions', async template => {
  await run(`consumer-${template}`, template);
  const target = join(root, `consumer-${template}`);
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  expect(pkg).toMatchObject({ name: `consumer-${template}`, packageManager: 'pnpm@11.25.0', engines: { node: '>=22.22.0' }, dependencies: { '@zucker-framework/fe-auth': '1.0.2' } });
  expect(readFileSync(join(target, 'AGENTS.md'), 'utf8')).toContain('Use public packages');
  expect(readlinkSync(join(target, 'CLAUDE.md'))).toBe('AGENTS.md');
  expect(existsSync(join(target, '.env'))).toBe(false);
});

it('preserves the independent minimal Server mode and adds its own instructions', async () => {
  await run('consumer-server', 'server');
  expect(readFileSync(join(root, 'consumer-server/src/app.module.ts'), 'utf8')).toContain('InMemoryAdapter');
  expect(lstatSync(join(root, 'consumer-server/.env')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(root, 'consumer-server/README.md'), 'utf8')).toContain('not persistent storage');
  expect(readlinkSync(join(root, 'consumer-server/CLAUDE.md'))).toBe('AGENTS.md');
});

function useCheckoutRuntime() {
  const checkout = join(root, 'checkout');
  const dist = join(checkout, 'packages/cli/dist');
  mkdirSync(dist, { recursive: true });
  for (const file of ['release-catalog.json', 'project-templates.json']) writeFileSync(join(dist, file), readFileSync(join(runtime, file)));
  writeFileSync(join(checkout, 'packages/cli/package.json'), JSON.stringify({ name: '@zucker-framework/cli' }));
  writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  runtime = dist;
}

it('ignores a templates/server directory next to an installed CLI', async () => {
  const source = resolve(runtime, '../../..', 'templates/server');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'src/app.module.ts'), 'export class PlantedModule {}');
  await run('installed-server', 'server');
  const module = readFileSync(join(root, 'installed-server/src/app.module.ts'), 'utf8');
  expect(module).toContain('InMemoryAdapter');
  expect(module).not.toContain('PlantedModule');
});

it('preserves the full checkout Server mode without copying local state or maintainer instructions', async () => {
  useCheckoutRuntime();
  const source = resolve(runtime, '../../..', 'templates/server');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'src/app.module.ts'), 'export class FullServerModule {}');
  writeFileSync(join(source, '.env'), 'PRIVATE_SYNTHETIC_FIXTURE=true');
  writeFileSync(join(source, 'AGENTS.md'), 'Maintainer-only instructions');
  await run('full-server', 'server');
  expect(readFileSync(join(root, 'full-server/src/app.module.ts'), 'utf8')).toContain('FullServerModule');
  expect(readFileSync(join(root, 'full-server/AGENTS.md'), 'utf8')).toContain('Use public packages');
  expect(existsSync(join(root, 'full-server/.env'))).toBe(false);
});

it('does not fall back to nearby source templates if bundled frontend assets are missing', async () => {
  const source = resolve(runtime, '../../..', 'templates/admin');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify({ ...templates(), templates: {} }));
  await expect(run('missing', 'admin')).rejects.toThrow('Template bundle');
  expect(existsSync(join(root, 'missing'))).toBe(false);
});

it('rejects an incomplete catalog before creating consumer files', async () => {
  writeFileSync(join(runtime, 'release-catalog.json'), JSON.stringify({ versions: {}, server: { dependencies: {}, devDependencies: {} } }));
  await expect(run('missing-version', 'admin')).rejects.toThrow('No release version');
  expect(existsSync(join(root, 'missing-version'))).toBe(false);
});

it('does not overwrite existing files or follow a dangling target link', async () => {
  mkdirSync(join(root, 'existing'));
  writeFileSync(join(root, 'existing/AGENTS.md'), 'Existing instructions');
  await expect(run('existing', 'web')).rejects.toThrow('already exists');
  expect(readFileSync(join(root, 'existing/AGENTS.md'), 'utf8')).toBe('Existing instructions');
  symlinkSync(join(root, 'missing-target'), join(root, 'dangling'));
  await expect(run('dangling', 'web')).rejects.toThrow('already exists');
  expect(existsSync(join(root, 'missing-target'))).toBe(false);
});

it('excludes local state and symlinks using relative paths even under a dist ancestor', () => {
  const source = join(root, 'dist/source');
  for (const name of ['package.json', 'src/index.ts', '.env.example', '.env', '.env.local', '.npmrc', '.next/types.ts', 'node_modules/fake/index.js', 'next-env.d.ts', 'AGENTS.md', 'private.key']) {
    const file = join(source, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, name === 'package.json' ? '{}' : 'synthetic');
  }
  symlinkSync(join(source, '.env'), join(source, 'outside-link'));
  expect(Object.keys(collectTemplateAssets(source)).sort()).toEqual(['.env.example', 'package.json', 'src/index.ts']);
});

it.each(['../escape', '/outside', 'C:/outside', 'src/../../outside', 'src\\outside', '.env.production', '.git/config'])('rejects invalid bundled path %s', path => {
  expect(() => validateTemplateAssets({ 'package.json': encode('{}'), [path]: encode('synthetic') })).toThrow('Invalid template asset');
});


it('creates server-full from bundled assets rather than any nearby checkout or minimal fallback', async () => {
  const nearby = resolve(runtime, '../../..', 'templates/server');
  mkdirSync(join(nearby, 'src'), { recursive: true });
  writeFileSync(join(nearby, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(nearby, 'src/app.module.ts'), 'UNRELATED_NEARBY_SERVER');
  await run('independent-full', 'server-full');
  const target = join(root, 'independent-full');
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  expect(pkg.dependencies['@zucker-framework/auth']).toBe('1.0.8');
  expect(pkg.devDependencies['@zucker-framework/core']).toBe('1.0.8');
  expect(pkg.peerDependencies['@zucker-framework/event']).toBe('1.0.8');
  expect(pkg.optionalDependencies['@zucker-framework/storage']).toBe('1.0.8');
  expect(JSON.stringify(pkg)).not.toContain('workspace:');
  expect(readFileSync(join(target, 'src/app.module.ts'), 'utf8')).toContain('Synthetic full Server');
  expect(readFileSync(join(target, 'src/app.module.ts'), 'utf8')).not.toMatch(/InMemoryAdapter|UNRELATED_NEARBY/);
  expect(existsSync(join(target, 'prisma/migrations/20261024000100_credential_version/migration.sql'))).toBe(true);
  expect(existsSync(join(target, 'eslint.config.cjs'))).toBe(true);
  expect(lstatSync(join(target, '.env')).mode & 0o777).toBe(0o600);
  expect(existsSync(join(target, 'src/generated'))).toBe(false);
  expect(readlinkSync(join(target, 'CLAUDE.md'))).toBe('AGENTS.md');
});

it('does not fall back to a nearby Server or a memory scaffold when server-full assets are incomplete', async () => {
  const bundle = templates();
  delete bundle.templates['server-full']['prisma/schema.prisma'];
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(bundle));
  await expect(run('incomplete-full', 'server-full')).rejects.toThrow('missing required asset');
  expect(existsSync(join(root, 'incomplete-full'))).toBe(false);
});


it('creates independent private JWT and configuration keys without exposing them or filling database credentials', async () => {
  const bundle = templates();
  bundle.templates['server-full']['.env.example'] = encode('DATABASE_URL=\nJWT_SECRET=\nSMTP_PASSWORD=\n');
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(bundle));
  await run('full-one', 'server-full');
  await run('full-two', 'server-full');
  const one = readFileSync(join(root, 'full-one/.env'), 'utf8');
  const two = readFileSync(join(root, 'full-two/.env'), 'utf8');
  const firstSecret = /^JWT_SECRET=(.+)$/m.exec(one)?.[1] ?? '';
  const secondSecret = /^JWT_SECRET=(.+)$/m.exec(two)?.[1] ?? '';
  const firstConfigKey = /^CONFIG_ENCRYPTION_KEY=(.+)$/m.exec(one)?.[1] ?? '';
  const secondConfigKey = /^CONFIG_ENCRYPTION_KEY=(.+)$/m.exec(two)?.[1] ?? '';
  expect([firstConfigKey, secondConfigKey].every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  expect(new Set([firstSecret, secondSecret, firstConfigKey, secondConfigKey]).size).toBe(4);
  expect(/^[a-f0-9]{64}$/.test(firstSecret)).toBe(true);
  expect(firstSecret === secondSecret).toBe(false);
  expect(one.includes('DATABASE_URL=\n')).toBe(true);
  expect(one.includes('SMTP_PASSWORD=\n')).toBe(true);
  expect(lstatSync(join(root, 'full-one/.env')).mode & 0o777).toBe(0o600);
  const output = vi.mocked(console.log).mock.calls.flat().join('\n');
  expect(output.includes(firstSecret) || output.includes(secondSecret)).toBe(false);
  expect(output.includes(firstConfigKey) || output.includes(secondConfigKey)).toBe(false);
});
