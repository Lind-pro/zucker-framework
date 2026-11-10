import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';

export interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

/** Matches the CLI's `engines.node` (>=22.12.0). */
const MIN_NODE = [22, 12, 0] as const;

export function meetsNodeRequirement(version: string): boolean {
  const parts = version.split('.').map((part) => parseInt(part, 10) || 0);
  for (let index = 0; index < MIN_NODE.length; index++) {
    if ((parts[index] ?? 0) !== MIN_NODE[index]) return (parts[index] ?? 0) > MIN_NODE[index];
  }
  return true;
}

export function describeSecret(value: string): string {
  return `Set (${value.length} characters)`;
}

/** Key material checks. Reports lengths and relations only, never any part of a value. */
export function checkSecrets(env: NodeJS.ProcessEnv): CheckResult[] {
  const results: CheckResult[] = [];
  const jwt = env.JWT_SECRET?.trim() ?? '';
  const config = env.CONFIG_ENCRYPTION_KEY?.trim() ?? '';
  if (jwt && jwt.length < 32) results.push({ name: 'JWT_SECRET length', status: 'error', message: `Too short (${jwt.length} characters); use at least 32 random characters.` });
  if (!config) {
    results.push({ name: 'CONFIG_ENCRYPTION_KEY', status: 'warn', message: 'Not set. Saved provider settings cannot be encrypted.' });
  } else if (config.length < 32) {
    results.push({ name: 'CONFIG_ENCRYPTION_KEY', status: 'error', message: `Too short (${config.length} characters); use at least 32 random characters.` });
  } else if (config === jwt) {
    results.push({ name: 'CONFIG_ENCRYPTION_KEY', status: 'error', message: 'Must differ from JWT_SECRET.' });
  } else {
    results.push({ name: 'CONFIG_ENCRYPTION_KEY', status: 'ok', message: describeSecret(config) });
  }
  return results;
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** Browser origins must agree: the server's CORS list has to contain every app that calls it. */
export function checkOrigins(env: NodeJS.ProcessEnv): CheckResult[] {
  const results: CheckResult[] = [];
  const raw = env.ACCOUNT_ORIGINS?.trim();
  if (!raw) return results;
  const origins = raw.split(',').map(value => value.trim()).filter(Boolean);
  const invalid = origins.filter(value => parseOrigin(value) !== value.replace(/\/+$/, ''));
  if (invalid.length) {
    results.push({ name: 'ACCOUNT_ORIGINS', status: 'error', message: `Not plain http(s) origins: ${invalid.join(', ')}` });
    return results;
  }
  const allowed = new Set(origins.map(value => parseOrigin(value)));
  const production = env.NODE_ENV === 'production';
  for (const key of ['WEB_URL', 'SITE_URL', 'ADMIN_URL']) {
    const value = env[key]?.trim();
    if (!value) continue;
    const origin = parseOrigin(value);
    if (!origin) results.push({ name: key, status: 'error', message: 'Not an http(s) URL.' });
    else if (!allowed.has(origin)) results.push({ name: key, status: 'error', message: `${origin} is missing from ACCOUNT_ORIGINS.` });
    else if (production && origin.startsWith('http:')) results.push({ name: key, status: 'warn', message: 'Uses http in production; serve it over HTTPS.' });
    else results.push({ name: key, status: 'ok', message: origin });
  }
  const web = env.WEB_URL?.trim() && parseOrigin(env.WEB_URL.trim());
  const site = env.SITE_URL?.trim() && parseOrigin(env.SITE_URL.trim());
  if (web && site && web !== site) results.push({ name: 'SITE_URL', status: 'warn', message: 'Differs from WEB_URL; links in mail and canonical URLs will disagree.' });
  return results;
}

/** Minimal database client surface, so the check can run against a fake in tests. */
export interface DiagnosticDatabase {
  query<T>(sql: string): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

/**
 * Reachability and schema readiness (migrations applied, none failed). Connection errors report the
 * driver's error code only: messages can contain the host, user or other parts of DATABASE_URL.
 */
export async function checkDatabase(url: string | undefined,
  connect: (url: string) => DiagnosticDatabase = value => new Pool({ connectionString: value, max: 1, connectionTimeoutMillis: 3000 })): Promise<CheckResult[]> {
  if (!url?.trim()) return [];
  const database = connect(url.trim());
  try {
    await database.query('SELECT 1');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    await database.end().catch(() => undefined);
    return [{ name: 'Database', status: 'error', message: `Unreachable${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : ''}. Is PostgreSQL running (pnpm dev:infra)?` }];
  }
  const results: CheckResult[] = [{ name: 'Database', status: 'ok', message: 'Reachable' }];
  try {
    const table = await database.query<{ present: boolean }>(`SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present`);
    if (!table.rows[0]?.present) {
      results.push({ name: 'Schema', status: 'error', message: 'No migrations applied. Run pnpm db:migrate.' });
    } else {
      const state = await database.query<{ applied: string; failed: string }>(
        `SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::text AS applied,
                count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::text AS failed
           FROM _prisma_migrations`);
      const { applied = '0', failed = '0' } = state.rows[0] ?? {};
      results.push(failed !== '0'
        ? { name: 'Schema', status: 'error', message: `${failed} migration(s) failed or unfinished. Resolve with prisma migrate resolve.` }
        : { name: 'Schema', status: 'ok', message: `${applied} migration(s) applied` });
    }
  } catch {
    results.push({ name: 'Schema', status: 'error', message: 'Could not read migration state.' });
  } finally {
    await database.end().catch(() => undefined);
  }
  return results;
}

export async function runDiagnostics(options: { database?: typeof checkDatabase } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const workspaceRoot = process.cwd();
  // In a `zucker create` workspace the server app holds the framework dependencies and tsconfig.
  const cwd = existsSync(resolve(workspaceRoot, 'apps/server/package.json')) ? resolve(workspaceRoot, 'apps/server') : workspaceRoot;

  // 1. Check package.json exists
  const pkgPath = resolve(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    results.push({
      name: 'package.json',
      status: 'error',
      message: 'package.json not found. Are you in a Zucker project directory?',
    });
    return results;
  }
  results.push({ name: 'package.json', status: 'ok', message: 'Found' });

  // 2. Check Node.js version
  const nodeVersion = process.versions.node;
  if (!meetsNodeRequirement(nodeVersion)) {
    results.push({
      name: 'Node.js',
      status: 'error',
      message: `v${nodeVersion} detected. Zucker requires Node.js >= ${MIN_NODE.join('.')}.`,
    });
  } else {
    results.push({ name: 'Node.js', status: 'ok', message: `v${nodeVersion}` });
  }

  // 3. Check for required Zucker packages
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    results.push({ name: 'package.json', status: 'error', message: 'Failed to parse package.json' });
    return results;
  }

  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };

  const requiredPkgs = ['@zucker-framework/core', '@zucker-framework/crud', '@zucker-framework/common'];
  for (const name of requiredPkgs) {
    if (deps[name]) {
      results.push({ name, status: 'ok', message: deps[name] });
    } else {
      results.push({ name, status: 'warn', message: 'Not installed' });
    }
  }

  // 4. Check environment variables
  const envChecks: Array<{ name: string; envVar: string; required: boolean }> = [
    { name: 'JWT_SECRET', envVar: 'JWT_SECRET', required: true },
    { name: 'DATABASE_URL', envVar: 'DATABASE_URL', required: false },
  ];

  for (const check of envChecks) {
    const value = process.env[check.envVar];
    if (value) {
      results.push({
        name: check.name,
        status: 'ok',
        // Never echo any part of a secret: doctor output ends up in CI logs.
        message: describeSecret(value),
      });
    } else if (check.required) {
      results.push({
        name: check.name,
        status: 'warn',
        message: 'Not set. Required for production.',
      });
    } else {
      results.push({
        name: check.name,
        status: 'ok',
        message: 'Not set (optional — will use InMemoryAdapter)',
      });
    }
  }

  // 5. Check for a local environment file (`zucker init` writes `.env`)
  const envFile = ['.env', '.env.local'].find((file) => existsSync(resolve(workspaceRoot, file)) || existsSync(resolve(cwd, file)));
  if (envFile) {
    results.push({ name: '.env', status: 'ok', message: `Found ${envFile}` });
  } else {
    results.push({
      name: '.env',
      status: 'warn',
      message: 'Not found. Consider creating one for local development.',
    });
  }

  // 6. Check tsconfig.json
  const tsconfigPath = resolve(cwd, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    results.push({ name: 'tsconfig.json', status: 'ok', message: 'Found' });
  } else {
    results.push({ name: 'tsconfig.json', status: 'error', message: 'Not found' });
  }

  // 7. Key material, origin consistency, database reachability and schema readiness
  results.push(...checkSecrets(process.env), ...checkOrigins(process.env));
  results.push(...await (options.database ?? checkDatabase)(process.env.DATABASE_URL));

  return results;
}

function formatStatus(status: 'ok' | 'warn' | 'error'): string {
  switch (status) {
    case 'ok': return '\x1b[32m[OK]\x1b[0m';
    case 'warn': return '\x1b[33m[WARN]\x1b[0m';
    case 'error': return '\x1b[31m[ERROR]\x1b[0m';
  }
}

export const doctorCommand = new Command('doctor')
  .description('Check project health and configuration')
  .action(async () => {
    console.log('\n  Zucker Doctor\n');
    console.log('  Running diagnostics...\n');

    const results = await runDiagnostics();
    const maxNameLen = Math.max(...results.map((r) => r.name.length));

    for (const result of results) {
      const padding = ' '.repeat(maxNameLen - result.name.length);
      console.log(
        `  ${formatStatus(result.status)}  ${result.name}${padding}  ${result.message}`,
      );
    }

    const errors = results.filter((r) => r.status === 'error');
    const warnings = results.filter((r) => r.status === 'warn');

    console.log('');
    if (errors.length > 0) {
      console.log(`  \x1b[31m${errors.length} error(s)\x1b[0m found. Please fix them before proceeding.`);
    } else if (warnings.length > 0) {
      console.log(`  \x1b[33m${warnings.length} warning(s)\x1b[0m found. Review them for production readiness.`);
    } else {
      console.log('  \x1b[32mAll checks passed!\x1b[0m');
    }
    console.log('');
  });
