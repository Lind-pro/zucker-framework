// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeEnvironment, createCreateCommand, selectAppBlocks } from './create';
import type { ProjectBundle } from '../../tooling/project-templates.mjs';

let root: string;
let runtime: string;
const encode = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const serverFiles = ['README.md', '.gitignore', 'nest-cli.json', 'tsconfig.json', 'eslint.config.cjs', 'prisma.config.ts', 'prisma/schema.prisma', 'prisma/migrations/migration_lock.toml', 'prisma/migrations/20261024000000_initial/migration.sql', 'prisma/migrations/20261024000100_credential_version/migration.sql', 'src/main.ts', 'src/app.module.ts', 'src/database.ts', 'src/accounts/account.module.ts', 'src/accounts/account.controller.ts', 'src/accounts/account.guard.ts', 'src/accounts/account.service.ts', 'src/accounts/account-mailer.ts', 'src/accounts/create-administrator.ts', 'src/scripts/create-admin.ts'];
const compose = 'services:\n  server:\n    image: s\n# <zucker:web>\n  web:\n    image: w\n# </zucker:web>\n# <zucker:admin>\n  admin:\n    image: a\n# </zucker:admin>\n';
const bundle = (): ProjectBundle => ({ version: 1, consumerInstructions: '# Consumer\n', templates: {
  'server-full': { ...Object.fromEntries(serverFiles.map(path => [path, encode(`synthetic ${path}\n`)])),
    'package.json': encode({ name: '@zucker-framework/template-server', dependencies: { '@zucker-framework/core': 'workspace:*' } }),
    '.env.example': encode('DATABASE_URL=\nJWT_SECRET=\nCONFIG_ENCRYPTION_KEY=\nPORT=4200\nACCOUNT_ORIGINS=\nWEB_URL=\nRATE_LIMIT_REDIS_URL=\n'),
    Dockerfile: encode('FROM node\n') },
  web: { 'package.json': encode({ name: 'web', dependencies: { '@zucker-framework/fe-auth': 'workspace:*' } }), 'next.config.ts': encode(''), 'tsconfig.json': encode('{}'), 'src/app/[locale]/layout.tsx': encode(''), 'src/app/[locale]/(home)/page.tsx': encode(''), '.env.example': encode('API_URL=\nSITE_URL=\nDEFAULT_LOCALE=en\nADMIN_URL=\n') },
  admin: { 'package.json': encode({ name: 'admin', packageManager: 'pnpm@1.0.0', dependencies: { '@zucker-framework/fe-admin': 'workspace:*' } }), 'index.html': encode(''), 'vite.config.ts': encode(''), 'tsconfig.json': encode('{}'), 'src/main.tsx': encode(''), '.env.example': encode('API_PROXY_TARGET=\n') },
  workspace: { 'pnpm-workspace.yaml': encode('packages:\n  - "apps/*"\n'), 'docker-compose.yml': encode(compose), '.env.example': encode('POSTGRES_PASSWORD=\nDEFAULT_LOCALE=en\nVITE_DEFAULT_LOCALE=en\nREVALIDATE_SECRET=\n'), '.gitignore': encode('.env*\n!.env.example\n'), '.dockerignore': encode('**/.env*\n'), 'README.md': encode('# __NAME__\n<!-- <zucker:admin> -->\nadmin row\n<!-- </zucker:admin> -->\n'), 'scripts/with-env.mjs': encode('// synthetic\n') },
} });
const run = (...args: string[]) => createCreateCommand(runtime, root).parseAsync(args, { from: 'user' });
const env = (text: string) => Object.fromEntries(text.split('\n').filter(line => /^[A-Z0-9_]+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zucker-create-'));
  runtime = join(root, 'installed', 'cli', 'dist');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'release-catalog.json'), JSON.stringify({
    versions: { '@zucker-framework/core': '1.2.3', '@zucker-framework/fe-auth': '1.2.3', '@zucker-framework/fe-admin': '1.2.3', '@zucker-framework/cli': '1.2.3' },
    runtime: { node: '>=22.22.0', packageManager: 'pnpm@11.25.0' }, server: { dependencies: {}, devDependencies: {} },
  }));
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(bundle()));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('writes one workspace with pinned released versions, one private .env and per-project secrets', async () => {
  await run('one');
  await run('two', '--locale', 'zh');
  const target = join(root, 'one');
  for (const path of ['apps/server/Dockerfile', 'apps/web/next.config.ts', 'apps/admin/index.html', 'docker-compose.yml', 'pnpm-workspace.yaml', 'scripts/with-env.mjs', 'AGENTS.md', '.env.example'])
    expect(existsSync(join(target, path)), path).toBe(true);
  expect(existsSync(join(target, 'apps/server/.env.example'))).toBe(false);
  expect(existsSync(join(target, 'apps/server/.env'))).toBe(false);
  const server = JSON.parse(readFileSync(join(target, 'apps/server/package.json'), 'utf8'));
  expect(server).toMatchObject({ name: 'one-server', dependencies: { '@zucker-framework/core': '1.2.3' } });
  const admin = JSON.parse(readFileSync(join(target, 'apps/admin/package.json'), 'utf8'));
  expect(admin.packageManager).toBeUndefined();
  expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))).toMatchObject({ name: 'one', packageManager: 'pnpm@11.25.0', devDependencies: { '@zucker-framework/cli': '1.2.3' } });
  expect(readFileSync(join(root, 'one/README.md'), 'utf8')).toBe('# one\nadmin row\n');

  expect(lstatSync(join(target, '.env')).mode & 0o777).toBe(0o600);
  const one = env(readFileSync(join(target, '.env'), 'utf8'));
  const two = env(readFileSync(join(root, 'two/.env'), 'utf8'));
  const secretKeys = ['JWT_SECRET', 'CONFIG_ENCRYPTION_KEY', 'REVALIDATE_SECRET', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'FILES_S3_SECRET_ACCESS_KEY'];
  for (const key of secretKeys) {
    expect(one[key], key).toMatch(/^[a-f0-9]{48,64}$/);
    expect(one[key]).not.toBe(two[key]);
  }
  expect(new Set(secretKeys.map(key => one[key])).size).toBe(secretKeys.length);
  expect(one.DATABASE_URL).toBe(`postgresql://app:${one.POSTGRES_PASSWORD}@localhost:5432/one`);
  expect(one).toMatchObject({ ACCOUNT_ORIGINS: 'http://localhost:4202,http://localhost:4201', WEB_URL: 'http://localhost:4202', SITE_URL: 'http://localhost:4202',
    API_URL: 'http://localhost:4200/api', API_PROXY_TARGET: 'http://localhost:4200', ADMIN_URL: 'http://localhost:4201', DEFAULT_LOCALE: 'en' });
  expect(one.PORT).toBeUndefined();
  expect(two).toMatchObject({ DEFAULT_LOCALE: 'zh', VITE_DEFAULT_LOCALE: 'zh' });
  const example = env(readFileSync(join(target, '.env.example'), 'utf8'));
  for (const key of secretKeys) expect(example[key], key).toBe('');
  expect(Object.keys(example).sort()).toEqual(Object.keys(one).sort());

  const output = vi.mocked(console.log).mock.calls.flat().join('\n');
  for (const key of secretKeys) expect(output.includes(one[key])).toBe(false);
});

it('omits apps, their compose services and origins with --no-admin / --no-web', async () => {
  await run('lite', '--no-admin');
  expect(existsSync(join(root, 'lite/apps/admin'))).toBe(false);
  const composeFile = readFileSync(join(root, 'lite/docker-compose.yml'), 'utf8');
  expect(composeFile).toContain('web:');
  expect(composeFile).not.toMatch(/admin|zucker:/);
  expect(env(readFileSync(join(root, 'lite/.env'), 'utf8'))).toMatchObject({ ACCOUNT_ORIGINS: 'http://localhost:4202', ADMIN_URL: '' });
  await run('api-only', '--no-admin', '--no-web');
  expect(existsSync(join(root, 'api-only/apps/web'))).toBe(false);
  expect(env(readFileSync(join(root, 'api-only/.env'), 'utf8')).ACCOUNT_ORIGINS).toBe('http://localhost:4200');
});

it('refuses an existing directory, bad names and locales, and leaves nothing behind on failure', async () => {
  mkdirSync(join(root, 'taken'));
  await expect(run('taken')).rejects.toThrow('already exists');
  await expect(run('Bad Name')).rejects.toThrow('Project name');
  await expect(run('x', '--locale', 'fr')).rejects.toThrow('Unsupported locale');
  const incomplete = bundle();
  delete (incomplete.templates as Partial<ProjectBundle['templates']>).workspace;
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(incomplete));
  await expect(run('no-shell')).rejects.toThrow('workspace template');
  expect(existsSync(join(root, 'no-shell'))).toBe(false);
  writeFileSync(join(runtime, 'release-catalog.json'), JSON.stringify({ versions: {}, server: { dependencies: {}, devDependencies: {} } }));
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(bundle()));
  await expect(run('unpinned')).rejects.toThrow('No release version');
  expect(existsSync(join(root, 'unpinned'))).toBe(false);
});

it('keeps the first assignment of a key and nested app blocks', () => {
  expect(composeEnvironment([{ title: '', text: 'A=1\n# c\nB=\n' }, { title: 'Web', text: 'A=2\nC=x\n' }], { B: 'b' }, { C: 'reason' }))
    .toBe('A=1\n# c\nB=b\n\n# ═══ Web ═══════════════════════════════════════════════════════════════════\n# C is not set here: reason\n');
  expect(selectAppBlocks('a\n# <zucker:web>\nw\n# <zucker:admin>\nx\n# </zucker:admin>\n# </zucker:web>\nz', new Set(['server', 'admin']))).toBe('a\nz');
});
