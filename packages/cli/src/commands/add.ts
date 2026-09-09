import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

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

function detectPackageManager(): 'pnpm' | 'npm' | 'yarn' {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml')) || existsSync(resolve(cwd, 'pnpm-workspace.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(resolve(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export const addCommand = new Command('add')
  .description('Add a Zucker module to the current project')
  .argument('<module>', `Module name (${Object.keys(MODULE_REGISTRY).join(', ')})`)
  .option('--dry-run', 'Show what would be done without making changes', false)
  .action(async (moduleName: string, options: { dryRun: boolean }) => {
    const entry = MODULE_REGISTRY[moduleName];
    if (!entry) {
      console.log(`\n  \x1b[31mError:\x1b[0m Unknown module "${moduleName}".`);
      console.log(`  Available modules: ${Object.keys(MODULE_REGISTRY).join(', ')}\n`);
      process.exit(1);
    }

    console.log(`\n  Adding @zucker-framework/${moduleName} to your project...\n`);

    // 1. Install the package
    const pm = detectPackageManager();
    const pkgs = [entry.pkg, ...(entry.peerDeps ?? [])];
    const installCmd = pm === 'pnpm'
      ? `pnpm add ${pkgs.join(' ')}`
      : pm === 'yarn'
        ? `yarn add ${pkgs.join(' ')}`
        : `npm install ${pkgs.join(' ')}`;

    if (options.dryRun) {
      console.log(`  [dry-run] Would run: ${installCmd}`);
    } else {
      console.log(`  Running: ${installCmd}`);
      try {
        execSync(installCmd, { stdio: 'inherit', cwd: process.cwd() });
      } catch {
        console.log(`\n  \x1b[33mWarning:\x1b[0m Package install failed. You may need to install manually.\n`);
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
