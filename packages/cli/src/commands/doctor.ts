import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

interface CheckResult {
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

export async function runDiagnostics(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const cwd = process.cwd();

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
  const envFile = ['.env', '.env.local'].find((file) => existsSync(resolve(cwd, file)));
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
