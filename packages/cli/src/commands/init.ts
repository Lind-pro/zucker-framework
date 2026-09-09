import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'fs';
import { resolve, join } from 'path';
import { randomBytes } from 'node:crypto';

interface ReleaseCatalog {
  versions: Record<string, string>;
  server: { dependencies: Record<string, string>; devDependencies: Record<string, string> };
}

function readReleaseCatalog(): ReleaseCatalog {
  const path = resolve(__dirname, 'release-catalog.json');
  if (!existsSync(path)) throw new Error('CLI release catalog is missing; build or reinstall the CLI package.');
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseCatalog;
}

const AVAILABLE_MODULES = [
  { name: 'auth', pkg: '@zucker-framework/auth', description: 'Authentication & authorization' },
  { name: 'logging', pkg: '@zucker-framework/logging', description: 'Access logging' },
  { name: 'config', pkg: '@zucker-framework/config', description: 'System configuration' },
  { name: 'dictionary', pkg: '@zucker-framework/dictionary', description: 'Data dictionary' },
  { name: 'cache', pkg: '@zucker-framework/cache', description: 'Caching layer' },
  { name: 'storage', pkg: '@zucker-framework/storage', description: 'File storage' },
  { name: 'notification', pkg: '@zucker-framework/notification', description: 'Notification system' },
  { name: 'credit', pkg: '@zucker-framework/credit', description: 'Credit/points system' },
  { name: 'ai', pkg: '@zucker-framework/ai', description: 'AI integration' },
  { name: 'i18n', pkg: '@zucker-framework/i18n', description: 'Internationalization' },
  { name: 'tenant', pkg: '@zucker-framework/tenant', description: 'Multi-tenancy' },
  { name: 'form', pkg: '@zucker-framework/form', description: 'Dynamic form engine' },
  { name: 'monitoring', pkg: '@zucker-framework/monitoring', description: 'System monitoring' },
];

export const initCommand = new Command('init')
  .description('Initialize a new Zucker project')
  .argument('[name]', 'Project name', 'zucker-app')
  .option('--template <template>', 'Template to use (server, admin, web)', 'server')
  .action(async (name: string, options: { template: string }) => {
    if (!['server', 'admin', 'web'].includes(options.template)) {
      throw new Error(`Unsupported template: ${options.template}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Project name must use lowercase letters, digits, dots, underscores or hyphens.');
    const catalog = readReleaseCatalog();
    const targetDir = resolve(process.cwd(), name);

    console.log(`\n  Initializing Zucker project: ${name}`);
    console.log(`  Template: ${options.template}`);
    console.log(`  Directory: ${targetDir}\n`);

    // Check if directory already exists
    if (existsSync(targetDir)) {
      console.log(`  \x1b[31mError:\x1b[0m Directory "${name}" already exists.`);
      process.exit(1);
    }

    // Locate the template directory
    // Try to resolve from the monorepo first, then from installed package
    const monorepoTemplate = resolve(__dirname, '..', '..', '..', 'templates', options.template);
    const templateDir = existsSync(monorepoTemplate) ? monorepoTemplate : null;

    if (!templateDir) {
      if (options.template !== 'server') {
        throw new Error(`The ${options.template} template requires a framework checkout. The installed CLI includes the standalone server scaffold.`);
      }
      console.log(`  \x1b[33mNote:\x1b[0m Template "${options.template}" not found locally.`);
      console.log('  Generating minimal project scaffold instead.\n');

      // Generate a minimal scaffold
      mkdirSync(resolve(targetDir, 'src'), { recursive: true });

      // package.json
      const pkg = {
        name,
        version: '0.1.0',
        private: true,
        type: 'commonjs',
        engines: { node: '>=22.12.0' },
        scripts: {
          dev: 'nest start --watch',
          build: 'nest build',
          start: 'node dist/main.js',
        },
        dependencies: catalog.server.dependencies,
        devDependencies: catalog.server.devDependencies,
      };
      writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

      // tsconfig.json
      const tsconfig = {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          sourceMap: false,
          declarationMap: false,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src'],
      };
      writeFileSync(resolve(targetDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
      writeFileSync(resolve(targetDir, 'nest-cli.json'), JSON.stringify({ sourceRoot: 'src', compilerOptions: { deleteOutDir: true } }, null, 2) + '\n');
      writeFileSync(resolve(targetDir, '.gitignore'), 'node_modules/\ndist/\n.env\n.env.local\n');
      writeFileSync(resolve(targetDir, '.env'), `JWT_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });

      // Document configuration without exposing the generated local secret.
      writeFileSync(resolve(targetDir, '.env.example'), [
        '# JWT secret — required for production',
        '# JWT_SECRET=your-secure-secret-here',
        '',
        '# Database URL — leave unset to use InMemoryAdapter',
        '# DATABASE_URL=postgresql://user:pass@localhost:5432/zucker',
        '',
      ].join('\n'));

      // Minimal main.ts
      writeFileSync(resolve(targetDir, 'src', 'main.ts'), [
        "import 'dotenv/config';",
        "import { NestFactory } from '@nestjs/core';",
        "import { ValidationPipe, Logger } from '@nestjs/common';",
        "import { HttpExceptionFilter } from '@zucker-framework/common';",
        "import { AppModule } from './app.module';",
        '',
        'async function bootstrap() {',
        '  const startTime = performance.now();',
        '  const app = await NestFactory.create(AppModule);',
        '',
        "  app.setGlobalPrefix('api');",
        '  app.useGlobalFilters(new HttpExceptionFilter());',
        '  app.useGlobalPipes(new ValidationPipe({ transform: true }));',
        '',
        '  const port = process.env.PORT || 4200;',
        '  await app.listen(port);',
        '',
        '  const elapsed = (performance.now() - startTime).toFixed(0);',
        '  Logger.log(`Server ready on http://localhost:${port} (${elapsed}ms)`, \'Bootstrap\');',
        '}',
        '',
        'bootstrap();',
        '',
      ].join('\n'));

      // Minimal app.module.ts
      writeFileSync(resolve(targetDir, 'src', 'app.module.ts'), [
        "import { Module } from '@nestjs/common';",
        "import { EventEmitterModule } from '@nestjs/event-emitter';",
        "import { ZuckerEventModule } from '@zucker-framework/event';",
        "import { ZuckerCommonModule } from '@zucker-framework/common';",
        "import { ZuckerCrudModule, InMemoryAdapter } from '@zucker-framework/crud';",
        "import { ZuckerAuthModule } from '@zucker-framework/auth';",
        '',
        '@Module({',
        '  imports: [',
        '    EventEmitterModule.forRoot(),',
        '    ZuckerEventModule.forRoot(),',
        '    ZuckerCommonModule,',
        '    ZuckerCrudModule.forRoot({ adapterClass: InMemoryAdapter }),',
        '    ZuckerAuthModule.forRoot({ jwtSecret: process.env.JWT_SECRET }),',
        '  ],',
        '})',
        'export class AppModule {}',
        '',
      ].join('\n'));

      console.log('  \x1b[32mProject scaffolded successfully!\x1b[0m\n');
      console.log('  Next steps:');
      console.log(`    cd ${name}`);
      console.log('    pnpm install');
      console.log('    pnpm dev\n');
      return;
    }

    // Copy template
    console.log(`  Copying template from ${templateDir}...\n`);
    cpSync(templateDir, targetDir, {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).some((part) =>
        ['node_modules', 'dist', '.turbo', '.next', '.cache', 'generated'].includes(part)
        || part.startsWith('.env') && part !== '.env.example'
        || part.endsWith('.tsbuildinfo')),
    });

    const copiedManifestPath = resolve(targetDir, 'package.json');
    const copiedManifest = JSON.parse(readFileSync(copiedManifestPath, 'utf8')) as Record<string, unknown>;
    copiedManifest.name = name;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const entries = copiedManifest[field] as Record<string, string> | undefined;
      for (const [dependency, version] of Object.entries(entries ?? {})) {
        if (!version.startsWith('workspace:')) continue;
        const releasedVersion = catalog.versions[dependency];
        if (!releasedVersion) throw new Error(`No release version found for ${dependency}`);
        entries![dependency] = releasedVersion;
      }
    }
    writeFileSync(copiedManifestPath, JSON.stringify(copiedManifest, null, 2) + '\n');

    console.log('  \x1b[32mProject created successfully!\x1b[0m\n');
    console.log('  Next steps:');
    console.log(`    cd ${name}`);
    console.log('    pnpm install');
    console.log('    pnpm dev\n');
  });
