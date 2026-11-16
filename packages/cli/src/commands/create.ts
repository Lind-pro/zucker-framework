import { Command } from 'commander';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'node:crypto';
import { writeTemplateAssets, type TemplateAssets } from '../../tooling/project-templates.mjs';
import {
  assertReleasedVersions, installInstructions, installSkills, pinReleasedVersions, readProjectBundle, readReleaseCatalog,
  type ReleaseCatalog,
} from './project-files';

export type WorkspaceApp = 'server' | 'web' | 'admin';
export type WorkspaceLocale = 'en' | 'zh';

export interface CreateOptions {
  locale: WorkspaceLocale;
  admin: boolean;
  web: boolean;
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const LOCALES: readonly WorkspaceLocale[] = ['en', 'zh'];
const ports = { server: 4200, admin: 4201, web: 4202 } as const;
const bundleTemplate = { server: 'server-full', web: 'web', admin: 'admin' } as const;
const APP_ORDER: readonly WorkspaceApp[] = ['server', 'web', 'admin'];

/** 32 random bytes, hex: the same key material the server template expects for its secrets. */
const secret = (bytes = 32) => randomBytes(bytes).toString('hex');

/**
 * Remove `<zucker:app>` blocks for apps that were not generated and drop the markers of the kept ones.
 * Markers sit on their own line, as a YAML comment (`# <zucker:web>`) or an HTML comment in Markdown.
 */
export function selectAppBlocks(text: string, apps: ReadonlySet<WorkspaceApp>): string {
  const marker = /^[ \t]*(?:#|<!--)[ \t]*<(\/?)zucker:(server|web|admin)>[ \t]*(?:-->)?[ \t]*$/;
  const output: string[] = [];
  const skipping: string[] = [];
  for (const line of text.split('\n')) {
    const match = marker.exec(line);
    if (match) {
      const [, closing, app] = match;
      if (closing) {
        if (skipping.at(-1) === app) skipping.pop();
      } else if (skipping.length || !apps.has(app as WorkspaceApp)) {
        skipping.push(app);
      }
      continue;
    }
    if (!skipping.length) output.push(line);
  }
  return output.join('\n');
}

interface EnvironmentSection { title: string; text: string }

/**
 * One `.env` from the workspace stack section and each app's `.env.example`. The first assignment of
 * a key wins (later duplicates are dropped), `values` replace assignments in place and keys absent
 * from every section are appended. `omit` keys become a comment explaining why they are unset.
 */
export function composeEnvironment(sections: EnvironmentSection[], values: Record<string, string>,
  omit: Record<string, string> = {}): string {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const section of sections) {
    if (section.title) lines.push('', `# ═══ ${section.title} ${'═'.repeat(Math.max(3, 70 - section.title.length))}`);
    for (const line of section.text.replace(/\r\n/g, '\n').trimEnd().split('\n')) {
      const key = assignment.exec(line)?.[1];
      if (!key) { lines.push(line); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      if (Object.hasOwn(omit, key)) lines.push(`# ${key} is not set here: ${omit[key]}`);
      else lines.push(Object.hasOwn(values, key) ? `${key}=${values[key]}` : line);
    }
  }
  const missing = Object.keys(values).filter(key => !seen.has(key));
  if (missing.length) lines.push('', '# Added by zucker create', ...missing.map(key => `${key}=${values[key]}`));
  return `${lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** Non-secret values shared by `.env` and `.env.example`: ports, origins, hosts and locale. */
export function workspaceSettings(name: string, apps: ReadonlySet<WorkspaceApp>, locale: WorkspaceLocale) {
  const origin = (app: WorkspaceApp) => `http://localhost:${ports[app]}`;
  const browserApps = APP_ORDER.filter(app => app !== 'server' && apps.has(app));
  const database = name.replace(/[^a-z0-9_]/g, '_');
  return {
    POSTGRES_USER: 'app',
    POSTGRES_DB: database,
    DEFAULT_LOCALE: locale,
    VITE_DEFAULT_LOCALE: locale,
    ACCOUNT_ORIGINS: (browserApps.length ? browserApps : ['server' as const]).map(origin).join(','),
    ...(apps.has('web') ? { WEB_URL: origin('web'), SITE_URL: origin('web') } : {}),
    ADMIN_URL: apps.has('admin') ? origin('admin') : '',
    API_URL: `${origin('server')}/api`,
    API_PROXY_TARGET: origin('server'),
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    SMTP_SECURE: 'false',
    SMTP_FROM: 'no-reply@example.com',
    FILES_STORAGE_PROVIDER: 's3',
    FILES_S3_BUCKET: 'app-files',
    FILES_S3_REGION: 'us-east-1',
    FILES_S3_ENDPOINT: 'http://localhost:9000',
  };
}

/** Per-project random credentials. Never printed; written only to the 0600 `.env`. */
export function workspaceSecrets(settings: ReturnType<typeof workspaceSettings>) {
  const postgresPassword = secret(24);
  const redisPassword = secret(24);
  return {
    POSTGRES_PASSWORD: postgresPassword,
    DATABASE_URL: `postgresql://${settings.POSTGRES_USER}:${postgresPassword}@localhost:5432/${settings.POSTGRES_DB}`,
    REDIS_PASSWORD: redisPassword,
    RATE_LIMIT_REDIS_URL: `redis://:${redisPassword}@localhost:6379`,
    MINIO_ROOT_USER: `root-${secret(6)}`,
    MINIO_ROOT_PASSWORD: secret(24),
    FILES_S3_ACCESS_KEY_ID: `app-${secret(8)}`,
    FILES_S3_SECRET_ACCESS_KEY: secret(32),
    // Authentication, stored provider settings and revalidation have independent key material.
    JWT_SECRET: secret(),
    CONFIG_ENCRYPTION_KEY: secret(),
    REVALIDATE_SECRET: secret(),
  };
}

function decode(files: TemplateAssets, path: string): string {
  return Buffer.from(files[path] ?? '', 'base64').toString('utf8');
}

function rootManifest(name: string, apps: ReadonlySet<WorkspaceApp>, catalog: ReleaseCatalog) {
  const cliVersion = catalog.versions['@zucker-framework/cli'];
  if (!cliVersion) throw new Error('No release version found for @zucker-framework/cli');
  const withEnv = (command: string) => `node scripts/with-env.mjs ${command}`;
  return {
    name,
    version: '0.1.0',
    private: true,
    ...(catalog.runtime?.packageManager ? { packageManager: catalog.runtime.packageManager } : {}),
    engines: { node: catalog.runtime?.node ?? '>=22.22.0' },
    scripts: {
      dev: withEnv('pnpm --parallel --filter "./apps/*" dev'),
      'dev:infra': 'docker compose up -d postgres redis minio minio-init mailpit',
      build: withEnv('pnpm --filter "./apps/*" build'),
      lint: 'pnpm --filter "./apps/*" lint',
      'db:migrate': withEnv('pnpm --filter ./apps/server db:migrate'),
      'setup:admin': withEnv('pnpm --filter ./apps/server account:admin'),
      doctor: withEnv('zucker doctor'),
      ...(apps.has('web') ? { 'dev:web': withEnv('pnpm --filter ./apps/web dev') } : {}),
      ...(apps.has('admin') ? { 'dev:admin': withEnv('pnpm --filter ./apps/admin dev') } : {}),
      'dev:server': withEnv('pnpm --filter ./apps/server dev'),
    },
    devDependencies: { '@zucker-framework/cli': cliVersion },
  };
}

export function createCreateCommand(runtimeDirectory?: string, workingDirectory?: string) {
  return new Command('create')
    .description('Create a workspace with server, web and admin apps, Docker Compose and one .env')
    .argument('<name>', 'Project directory and package name')
    .option('--locale <locale>', 'Default locale of web and admin (en or zh)', 'en')
    .option('--no-admin', 'Do not generate apps/admin')
    .option('--no-web', 'Do not generate apps/web')
    .action(async (name: string, options: CreateOptions) => {
      if (!PROJECT_NAME.test(name)) throw new Error('Project name must use lowercase letters, digits, dots, underscores or hyphens.');
      if (!LOCALES.includes(options.locale)) throw new Error(`Unsupported locale: ${String(options.locale)} (use en or zh)`);
      const apps = new Set<WorkspaceApp>(APP_ORDER.filter(app => app === 'server' || options[app as 'web' | 'admin']));
      const runtime = runtimeDirectory ?? __dirname;
      const catalog = readReleaseCatalog(runtime);
      const bundle = readProjectBundle(runtime);
      const shell = bundle.templates.workspace;
      if (!shell) throw new Error('CLI project assets have no workspace template; build or reinstall the CLI.');
      const targetDir = resolve(workingDirectory ?? process.cwd(), name);
      if (lstatSync(targetDir, { throwIfNoEntry: false })) throw new Error(`Directory "${name}" already exists.`);

      // Validate every manifest before the first file is written.
      for (const app of apps) {
        assertReleasedVersions(JSON.parse(decode(bundle.templates[bundleTemplate[app]], 'package.json')) as Record<string, unknown>, catalog);
      }
      const manifest = rootManifest(name, apps, catalog);

      console.log(`\n  Creating Zucker workspace: ${name}`);
      console.log(`  Apps: ${[...apps].join(', ')}  Locale: ${options.locale}`);
      console.log(`  Directory: ${targetDir}\n`);

      mkdirSync(targetDir);
      try {
        // Workspace shell, with blocks for omitted apps removed from text files.
        const selected: TemplateAssets = {};
        for (const [path, content] of Object.entries(shell)) {
          if (!/\.(?:ya?ml|md|example)$/.test(path)) { selected[path] = content; continue; }
          const text = selectAppBlocks(Buffer.from(content, 'base64').toString('utf8'), apps).replaceAll('__NAME__', name);
          selected[path] = Buffer.from(text).toString('base64');
        }
        // The root .env.example is composed below from every app's example.
        delete selected['.env.example'];
        writeTemplateAssets(selected, targetDir, { manifest: false });
        writeFileSync(join(targetDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

        const sections: EnvironmentSection[] = [{ title: '', text: decode(shell, '.env.example') }];
        for (const app of apps) {
          const files = { ...bundle.templates[bundleTemplate[app]] };
          if (files['.env.example']) sections.push({ title: `${app[0].toUpperCase()}${app.slice(1)} (apps/${app})`, text: decode(files, '.env.example') });
          // One root .env: per-app examples would suggest per-app files that nothing loads.
          delete files['.env.example'];
          const appDir = join(targetDir, 'apps', app);
          mkdirSync(appDir, { recursive: true });
          writeTemplateAssets(files, appDir);
          const appManifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as Record<string, unknown>;
          appManifest.name = `${name}-${app}`;
          // The root manifest owns packageManager; each app keeps the supported Node range.
          delete appManifest.packageManager;
          if (catalog.runtime?.node) appManifest.engines = { ...(appManifest.engines as object ?? {}), node: catalog.runtime.node };
          pinReleasedVersions(appManifest, catalog);
          writeFileSync(join(appDir, 'package.json'), `${JSON.stringify(appManifest, null, 2)}\n`);
        }

        const settings = workspaceSettings(name, apps, options.locale);
        const omit: Record<string, string> = {
          PORT: 'every app shares this file; the server listens on 4200 unless PORT is exported.',
          // Unset rather than empty: server URL readers distinguish an absent optional origin from
          // an explicitly invalid URL. Mail links need a consumer-owned frontend in --no-web mode.
          ...(!apps.has('web') ? {
            WEB_URL: 'no Web app was generated; set your own frontend origin before enabling account mail links.',
            SITE_URL: 'no Web app was generated; set this when adding your own public site.',
          } : {}),
        };
        const secretKeys = workspaceSecrets(settings);
        const blankSecrets = Object.fromEntries(Object.keys(secretKeys).map(key => [key, '']));
        writeFileSync(join(targetDir, '.env.example'), composeEnvironment(sections, { ...settings, ...blankSecrets }, omit), { flag: 'wx' });
        writeFileSync(join(targetDir, '.env'), composeEnvironment(sections, { ...settings, ...secretKeys }, omit), { mode: 0o600, flag: 'wx' });
        installInstructions(targetDir, bundle);
        installSkills(targetDir, bundle);
      } catch (error) {
        // Never leave a half-written workspace (with secrets) behind; the directory was created above.
        rmSync(targetDir, { recursive: true, force: true });
        throw error;
      }

      console.log('  \x1b[32mWorkspace created.\x1b[0m Secrets were generated into .env (mode 0600) and are not shown.\n');
      console.log('  Next steps:');
      console.log(`    cd ${name}`);
      console.log('    pnpm install');
      console.log('    pnpm dev:infra && pnpm db:migrate && pnpm dev');
      console.log('    # or everything in Docker: docker compose up -d --build\n');
    });
}

export const createCommand = createCreateCommand();

/** Programmatic entry used by @zucker-framework/create-app (`pnpm create @zucker-framework/app`). */
export async function runCreate(argv: readonly string[], runtimeDirectory?: string, workingDirectory?: string): Promise<void> {
  await createCreateCommand(runtimeDirectory, workingDirectory)
    .name('create-app')
    .parseAsync([...argv], { from: 'user' });
}
