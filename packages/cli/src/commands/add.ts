import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

const MODULE_REGISTRY: Record<string, {
  pkg: string;
  peerDeps?: string[];
  moduleImport: string;
  moduleSetup: string;
}> = {
  auth: {
    pkg: '@zucker-framework/auth',
    peerDeps: ['@nestjs/passport', '@nestjs/jwt'],
    moduleImport: "import { ZuckerAuthModule } from '@zucker-framework/auth';",
    moduleSetup: "ZuckerAuthModule.forRoot({ jwtSecret: process.env.JWT_SECRET })",
  },
  logging: {
    pkg: '@zucker-framework/logging',
    moduleImport: "import { ZuckerLoggingModule } from '@zucker-framework/logging';",
    moduleSetup: 'ZuckerLoggingModule.forRoot()',
  },
  config: {
    pkg: '@zucker-framework/config',
    moduleImport: "import { ZuckerConfigModule } from '@zucker-framework/config';",
    moduleSetup: 'ZuckerConfigModule.forRoot()',
  },
  dictionary: {
    pkg: '@zucker-framework/dictionary',
    moduleImport: "import { ZuckerDictionaryModule } from '@zucker-framework/dictionary';",
    moduleSetup: 'ZuckerDictionaryModule.forRoot()',
  },
  cache: {
    pkg: '@zucker-framework/cache',
    moduleImport: "import { ZuckerCacheModule } from '@zucker-framework/cache';",
    moduleSetup: "ZuckerCacheModule.forRoot({ provider: 'memory' })",
  },
  storage: {
    pkg: '@zucker-framework/storage',
    moduleImport: "import { ZuckerStorageModule } from '@zucker-framework/storage';",
    moduleSetup: "ZuckerStorageModule.forRoot({ provider: 'local', basePath: './uploads' })",
  },
  notification: {
    pkg: '@zucker-framework/notification',
    moduleImport: "import { ZuckerNotificationModule } from '@zucker-framework/notification';",
    moduleSetup: 'ZuckerNotificationModule.forRoot({ providers: [] })',
  },
  credit: {
    pkg: '@zucker-framework/credit',
    moduleImport: "import { ZuckerCreditModule } from '@zucker-framework/credit';",
    moduleSetup: 'ZuckerCreditModule.forRoot()',
  },
  ai: {
    pkg: '@zucker-framework/ai',
    moduleImport: "import { ZuckerAIModule } from '@zucker-framework/ai';",
    moduleSetup: 'ZuckerAIModule.forRoot()',
  },
  tenant: {
    pkg: '@zucker-framework/tenant',
    moduleImport: "import { ZuckerTenantModule } from '@zucker-framework/tenant';",
    moduleSetup: 'ZuckerTenantModule.forRoot()',
  },
  form: {
    pkg: '@zucker-framework/form',
    moduleImport: "import { ZuckerFormModule } from '@zucker-framework/form';",
    moduleSetup: 'ZuckerFormModule.forRoot()',
  },
  monitoring: {
    pkg: '@zucker-framework/monitoring',
    moduleImport: "import { ZuckerMonitoringModule } from '@zucker-framework/monitoring';",
    moduleSetup: 'ZuckerMonitoringModule',
  },
  'rate-limiter': {
    pkg: '@zucker-framework/rate-limiter',
    moduleImport: "import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';",
    moduleSetup: `ZuckerRateLimiterModule.forRoot({
      limiters: {
        login: { points: 5, duration: 900 },
        'api-default': { points: 100, duration: 60 },
      },
    })`,
  },
};

function detectPackageManager(cwd: string): 'pnpm' | 'npm' | 'yarn' {
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml')) || existsSync(resolve(cwd, 'pnpm-workspace.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(resolve(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

interface AddCatalog {
  versions: Record<string, string>;
  server?: { dependencies?: Record<string, string> };
}

function readAddCatalog(runtimeDirectory: string): AddCatalog {
  const path = resolve(runtimeDirectory, 'release-catalog.json');
  if (!existsSync(path)) throw new Error('CLI release catalog is missing; build or reinstall the CLI package.');
  const catalog = JSON.parse(readFileSync(path, 'utf8')) as AddCatalog;
  if (!catalog || typeof catalog.versions !== 'object') throw new Error('CLI release catalog is invalid; reinstall the CLI package.');
  return catalog;
}

/** Only real registry entries; `constructor`, `__proto__` and friends are unknown modules. */
export function findModule(name: string) {
  return Object.hasOwn(MODULE_REGISTRY, name) ? MODULE_REGISTRY[name] : undefined;
}

/**
 * Pin every package to the version this CLI release was built and tested with: framework packages
 * from the release catalog, Nest peers from the catalog's server dependency set.
 */
export function pinnedPackages(entry: { pkg: string; peerDeps?: string[] }, catalog: AddCatalog): string[] {
  const frameworkVersion = catalog.versions[entry.pkg];
  if (!frameworkVersion) throw new Error(`${entry.pkg} is not in this CLI's release catalog.`);
  const specs = [`${entry.pkg}@${frameworkVersion}`];
  for (const peer of entry.peerDeps ?? []) {
    const version = catalog.versions[peer] ?? catalog.server?.dependencies?.[peer];
    if (!version) throw new Error(`No released version for ${peer} in this CLI's release catalog.`);
    specs.push(`${peer}@${version}`);
  }
  return specs;
}

export type InstallRunner = (command: string, args: string[], cwd: string) => number | null;

const defaultInstallRunner: InstallRunner = (command, args, cwd) =>
  // Arguments are passed without a shell on POSIX; Windows needs one to resolve pnpm.cmd/npm.cmd.
  spawnSync(command, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' }).status;

export function createAddCommand(runtimeDirectory?: string, workingDirectory?: string, runInstall: InstallRunner = defaultInstallRunner) {
  return new Command('add')
  .description('Add a Zucker module to the current project')
  .argument('<module>', `Module name (${Object.keys(MODULE_REGISTRY).join(', ')})`)
  .option('--dry-run', 'Show what would be done without making changes', false)
  .action(async (moduleName: string, options: { dryRun: boolean }) => {
    const entry = findModule(moduleName);
    if (!entry) {
      console.log(`\n  \x1b[31mError:\x1b[0m Unknown module "${moduleName}".`);
      console.log(`  Available modules: ${Object.keys(MODULE_REGISTRY).join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    const cwd = workingDirectory ?? process.cwd();
    const specs = pinnedPackages(entry, readAddCatalog(runtimeDirectory ?? __dirname));

    console.log(`\n  Adding ${entry.pkg} to your project...\n`);

    // 1. Install the pinned packages
    const pm = detectPackageManager(cwd);
    const args = pm === 'npm' ? ['install', ...specs] : ['add', ...specs];
    const display = `${pm} ${args.join(' ')}`;

    if (options.dryRun) {
      console.log(`  [dry-run] Would run: ${display}`);
    } else {
      console.log(`  Running: ${display}`);
      const status = runInstall(pm, args, cwd);
      if (status !== 0) {
        console.error(`\n  \x1b[31mError:\x1b[0m Package install failed (${status === null ? 'terminated' : `exit ${status}`}). Install manually: ${display}\n`);
        process.exitCode = 1;
        return;
      }
    }

    // 2. Show import instructions
    console.log('\n  Add the following to your AppModule:\n');
    console.log(`  \x1b[36m// Import:\x1b[0m`);
    console.log(`  ${entry.moduleImport}\n`);
    console.log(`  \x1b[36m// In @Module imports array:\x1b[0m`);
    console.log(`  ${entry.moduleSetup},\n`);

    console.log('  \x1b[32mDone!\x1b[0m\n');
  });
}

export const addCommand = createAddCommand();
