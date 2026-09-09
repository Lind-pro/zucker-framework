import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

async function runDiagnostics(): Promise<CheckResult[]> {
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
  const major = parseInt(nodeVersion.split('.')[0], 10);
  if (major < 20) {
    results.push({
      name: 'Node.js',
      status: 'error',
      message: `v${nodeVersion} detected. Zucker requires Node.js >= 20.`,
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
        message: `Set (${value.substring(0, 8)}...)`,
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

  // 5. Check .env.local file
  const envLocalPath = resolve(cwd, '.env.local');
  if (existsSync(envLocalPath)) {
    results.push({ name: '.env.local', status: 'ok', message: 'Found' });
  } else {
    results.push({
      name: '.env.local',
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
