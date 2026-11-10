// @vitest-environment node
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCreateCommand } from './create';
// @ts-expect-error plain ESM script without types
import { prepareCliTemplates } from '../../../../scripts/prepare-cli-templates.mjs';
import type { ProjectBundle } from '../../tooling/project-templates.mjs';

/**
 * Generates workspaces from the REAL templates in this repository (bundled exactly as the release
 * script does) with a release catalog derived from the packages' own versions. Output goes to
 * `os.tmpdir()`, so run with TMPDIR pointing at a scratch directory.
 */
const repo = resolve(__dirname, '../../../..');
let base: string;
let runtime: string;
let cwd: string;
const SECRET_KEYS = ['JWT_SECRET', 'CONFIG_ENCRYPTION_KEY', 'REVALIDATE_SECRET', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'FILES_S3_SECRET_ACCESS_KEY'];

const parseEnv = (text: string) => Object.fromEntries(text.split('\n').filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out); else out.push(path);
  }
  return out;
};
const run = (...args: string[]) => createCreateCommand(runtime, cwd).parseAsync(args, { from: 'user' });
const decode = (value: string) => Buffer.from(value, 'base64').toString('utf8');

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'zucker-create-real-'));
  runtime = join(base, 'dist');
  mkdirSync(runtime, { recursive: true });
  prepareCliTemplates(repo, runtime);
  const versions: Record<string, string> = {};
  for (const entry of readdirSync(join(repo, 'packages'), { withFileTypes: true })) {
    const manifest = join(repo, 'packages', entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; version: string };
    versions[parsed.name] = parsed.version;
  }
  writeFileSync(join(runtime, 'release-catalog.json'), JSON.stringify({
    versions, runtime: { node: '>=22.22.0', packageManager: 'pnpm@11.25.0' }, server: { dependencies: {}, devDependencies: {} },
  }));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  cwd = mkdtempSync(join(base, 'run-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const captured = () => [console.log, console.warn, console.error].flatMap(fn => vi.mocked(fn).mock.calls.flat()).join('\n');

describe('bundled real templates', () => {
  it('ship Dockerfiles and .dockerignore for every app, nginx for admin, and the workspace shell', () => {
    const bundle = JSON.parse(readFileSync(join(runtime, 'project-templates.json'), 'utf8')) as ProjectBundle;
    for (const name of ['server-full', 'web', 'admin'] as const) {
      expect(bundle.templates[name].Dockerfile, `${name} Dockerfile`).toBeTruthy();
      expect(bundle.templates[name]['.dockerignore'], `${name} .dockerignore`).toBeTruthy();
    }
    expect(bundle.templates.admin['nginx.conf']).toBeTruthy();
    for (const path of ['pnpm-workspace.yaml', 'docker-compose.yml', '.env.example', '.gitignore', '.dockerignore', 'README.md', 'scripts/with-env.mjs'])
      expect(bundle.templates.workspace![path], path).toBeTruthy();
    for (const name of ['server-full', 'web', 'admin', 'workspace'] as const)
      expect(Object.keys(bundle.templates[name]).filter(p => /(^|\/)\.env(?!\.example)/.test(p)), name).toEqual([]);
  });

  it('Dockerfiles run as non-root, never COPY secrets, and never bake .env', () => {
    const bundle = JSON.parse(readFileSync(join(runtime, 'project-templates.json'), 'utf8')) as ProjectBundle;
    for (const name of ['server-full', 'web', 'admin'] as const) {
      const dockerfile = decode(bundle.templates[name].Dockerfile);
      // Non-root either through an explicit USER or an unprivileged base image (admin: nginx-unprivileged).
      expect(/^USER\s+(?!root\b)\S+/m.test(dockerfile) || /^ARG\s+NGINX_IMAGE=\S*nginx-unprivileged/m.test(dockerfile), name).toBe(true);
      expect(dockerfile, name).not.toMatch(/^USER\s+(root|0)\b/m);
      expect(dockerfile, name).not.toMatch(/COPY[^\n]*\.env/);
      expect(dockerfile, name).not.toMatch(/^(ARG|ENV)\s+\S*(SECRET|PASSWORD|TOKEN|KEY)\S*\s*=\s*\S+/mi);
      expect(dockerfile, name).not.toMatch(/FROM\s+\S+:latest\b/);
    }
  });
});

describe('zucker create with the real templates', () => {
  it('references only fixed released versions: no workspace:, link:, file:, ranges or tags for framework packages', async () => {
    await run('proj');
    const root = join(cwd, 'proj');
    const manifests = [join(root, 'package.json'), ...['server', 'web', 'admin'].map(app => join(root, 'apps', app, 'package.json'))];
    for (const path of manifests) {
      const raw = readFileSync(path, 'utf8');
      expect(raw, path).not.toMatch(/workspace:|"link:|"file:|"portal:|"catalog:/);
      const manifest = JSON.parse(raw) as Record<string, Record<string, string> | undefined>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
        for (const [name, version] of Object.entries(manifest[field] ?? {}))
          if (name.startsWith('@zucker-framework/'))
            expect(version, `${path} ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
    }
    const rootManifest = JSON.parse(readFileSync(manifests[0], 'utf8'));
    expect(rootManifest).toMatchObject({ name: 'proj', private: true, packageManager: 'pnpm@11.25.0' });
    expect(rootManifest.devDependencies['@zucker-framework/cli']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(readFileSync(manifests[1], 'utf8')).name).toBe('proj-server');
  });

  it('writes the expected tree including Dockerfiles, and no secrets outside the root .env', async () => {
    await run('tree');
    const root = join(cwd, 'tree');
    for (const path of ['apps/server/Dockerfile', 'apps/server/.dockerignore', 'apps/web/Dockerfile', 'apps/web/.dockerignore', 'apps/admin/Dockerfile', 'apps/admin/nginx.conf', 'docker-compose.yml', 'pnpm-workspace.yaml', '.env', '.env.example', '.gitignore', '.dockerignore', 'scripts/with-env.mjs'])
      expect(existsSync(join(root, path)), path).toBe(true);
    const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
    const values = SECRET_KEYS.map(key => env[key]);
    const leaks = walk(root).filter(file => !file.endsWith('/.env') && values.some(value => readFileSync(file, 'utf8').includes(value)));
    expect(leaks).toEqual([]);
    expect(walk(root).filter(file => /\/\.env(\.|$)/.test(file) && !/\.env(\.example)?$/.test(file))).toEqual([]);
    expect(walk(join(root, 'apps')).filter(file => /\/\.env(\.example)?$/.test(file))).toEqual([]);
  });

  it('.env secrets are random per run, mode 0600, distinct from each other, and never printed', async () => {
    await run('one');
    await run('two');
    await run('three', '--no-web', '--no-admin');
    const envs = ['one', 'two', 'three'].map(name => {
      const path = join(cwd, name, '.env');
      expect(statSync(path).mode & 0o777, name).toBe(0o600);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      return parseEnv(readFileSync(path, 'utf8'));
    });
    for (const key of [...SECRET_KEYS, 'MINIO_ROOT_USER', 'FILES_S3_ACCESS_KEY_ID', 'DATABASE_URL', 'RATE_LIMIT_REDIS_URL']) {
      const seen = envs.map(env => env[key]);
      expect(new Set(seen).size, key).toBe(3);
      for (const value of seen) expect(value, key).toBeTruthy();
    }
    for (const env of envs) {
      for (const key of ['JWT_SECRET', 'CONFIG_ENCRYPTION_KEY', 'REVALIDATE_SECRET']) expect(env[key], key).toMatch(/^[a-f0-9]{64}$/);
      expect(new Set(SECRET_KEYS.map(key => env[key])).size).toBe(SECRET_KEYS.length);
      expect(env.CONFIG_ENCRYPTION_KEY).not.toBe(env.JWT_SECRET);
      expect(env.DATABASE_URL).toContain(env.POSTGRES_PASSWORD);
      expect(env.RATE_LIMIT_REDIS_URL).toContain(env.REDIS_PASSWORD);
    }
    const output = captured();
    for (const env of envs)
      for (const value of [...SECRET_KEYS.map(key => env[key]), env.DATABASE_URL, env.RATE_LIMIT_REDIS_URL, env.MINIO_ROOT_USER, env.FILES_S3_ACCESS_KEY_ID])
        expect(output.includes(value)).toBe(false);
    expect(output).not.toMatch(/[a-f0-9]{32,}/);
  });

  it('.env.example has the same keys but no secret values and is not private', async () => {
    await run('ex');
    const env = parseEnv(readFileSync(join(cwd, 'ex/.env'), 'utf8'));
    const example = parseEnv(readFileSync(join(cwd, 'ex/.env.example'), 'utf8'));
    for (const key of SECRET_KEYS) expect(example[key], key).toBe('');
    expect(example.DATABASE_URL).not.toContain(env.POSTGRES_PASSWORD);
    expect(readFileSync(join(cwd, 'ex/.env.example'), 'utf8')).not.toMatch(/[a-f0-9]{32,}/);
    expect(readFileSync(join(cwd, 'ex/.gitignore'), 'utf8')).toMatch(/^\.env\*$/m);
  });

  it('--locale zh propagates to web and admin env; default is en; bad locale is refused before writing', async () => {
    await run('zh-proj', '--locale', 'zh');
    await run('en-proj');
    const zh = parseEnv(readFileSync(join(cwd, 'zh-proj/.env'), 'utf8'));
    expect(zh).toMatchObject({ DEFAULT_LOCALE: 'zh', VITE_DEFAULT_LOCALE: 'zh' });
    expect(parseEnv(readFileSync(join(cwd, 'en-proj/.env'), 'utf8'))).toMatchObject({ DEFAULT_LOCALE: 'en', VITE_DEFAULT_LOCALE: 'en' });
    // The Docker build args of web/admin read these variables from the single root file.
    const compose = readFileSync(join(cwd, 'zh-proj/docker-compose.yml'), 'utf8');
    expect(compose).toContain('DEFAULT_LOCALE');
    expect(compose).toContain('VITE_DEFAULT_LOCALE');
    expect(existsSync(join(cwd, 'zh-proj/apps/web/.env'))).toBe(false);
    await expect(run('bad-loc', '--locale', 'ZH')).rejects.toThrow('Unsupported locale');
    await expect(run('bad-loc2', '--locale', '')).rejects.toThrow('Unsupported locale');
    expect(existsSync(join(cwd, 'bad-loc'))).toBe(false);
  });

  it('--no-web and --no-admin leave no app, compose service or marker behind', async () => {
    await run('only-admin', '--no-web');
    const root = join(cwd, 'only-admin');
    expect(existsSync(join(root, 'apps/web'))).toBe(false);
    expect(existsSync(join(root, 'apps/admin/Dockerfile'))).toBe(true);
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    expect(compose).not.toMatch(/zucker:/);
    expect(compose).not.toMatch(/^  web:/m);
    expect(compose).toMatch(/^  admin:/m);
    expect(parseEnv(readFileSync(join(root, '.env'), 'utf8')).ACCOUNT_ORIGINS).toBe('http://localhost:4201');
    for (const file of walk(root).filter(f => /\.(ya?ml|md|example)$/.test(f))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/<zucker:/);
    await run('only-web', '--no-admin');
    expect(existsSync(join(cwd, 'only-web/apps/admin'))).toBe(false);
    expect(readFileSync(join(cwd, 'only-web/docker-compose.yml'), 'utf8')).not.toMatch(/^  admin:/m);
  });

  it('rejects unsafe project names before touching the filesystem', async () => {
    for (const name of ['Bad', 'has space', '../escape', '/abs', 'a/b', '-lead', '.hidden', 'semi;rm', 'x$(id)', 'x\ny', '', 'UPPER']) {
      await expect(run(name), JSON.stringify(name)).rejects.toThrow();
    }
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(join(cwd, '..', 'escape'))).toBe(false);
  });

  it('refuses to overwrite an existing directory or symlink and leaves it untouched', async () => {
    mkdirSync(join(cwd, 'taken'));
    writeFileSync(join(cwd, 'taken/keep.txt'), 'mine');
    await expect(run('taken')).rejects.toThrow('already exists');
    expect(readFileSync(join(cwd, 'taken/keep.txt'), 'utf8')).toBe('mine');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(cwd, 'taken'), join(cwd, 'link'));
    await expect(run('link')).rejects.toThrow('already exists');
    expect(readdirSync(join(cwd, 'taken'))).toEqual(['keep.txt']);
  });

  it('removes the half-written workspace (and its secrets) when generation fails midway', async () => {
    const bundlePath = join(runtime, 'project-templates.json');
    const original = readFileSync(bundlePath, 'utf8');
    try {
      const broken = JSON.parse(original) as ProjectBundle;
      // `src` as a file collides with `src/main.ts`: the write fails after the shell and .env inputs were handled.
      broken.templates.web = { ...broken.templates.web, src: Buffer.from('x').toString('base64') };
      writeFileSync(bundlePath, JSON.stringify(broken));
      await expect(run('half')).rejects.toThrow();
      expect(existsSync(join(cwd, 'half'))).toBe(false);
      expect(readdirSync(cwd)).toEqual([]);
      // Nothing about the failure may print a secret.
      expect(captured()).not.toMatch(/[a-f0-9]{48,}/);
    } finally {
      writeFileSync(bundlePath, original);
    }
    await run('after-failure');
    expect(existsSync(join(cwd, 'after-failure/.env'))).toBe(true);
  });

  it('a failure after .env was written (agent instructions step) still cleans everything', async () => {
    const bundlePath = join(runtime, 'project-templates.json');
    const original = readFileSync(bundlePath, 'utf8');
    try {
      const broken = JSON.parse(original) as ProjectBundle;
      broken.consumerInstructions = '';
      writeFileSync(bundlePath, JSON.stringify(broken));
      await expect(run('late')).rejects.toThrow();
      expect(existsSync(join(cwd, 'late'))).toBe(false);
    } finally {
      writeFileSync(bundlePath, original);
    }
  });
});
