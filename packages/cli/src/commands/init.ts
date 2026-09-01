import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'fs';
import { resolve, join } from 'path';

const AVAILABLE_MODULES = [
  { name: 'auth', pkg: '@zucker/auth', description: 'Authentication & authorization' },
  { name: 'logging', pkg: '@zucker/logging', description: 'Access logging' },
  { name: 'config', pkg: '@zucker/config', description: 'System configuration' },
  { name: 'dictionary', pkg: '@zucker/dictionary', description: 'Data dictionary' },
  { name: 'cache', pkg: '@zucker/cache', description: 'Caching layer' },
  { name: 'storage', pkg: '@zucker/storage', description: 'File storage' },
  { name: 'notification', pkg: '@zucker/notification', description: 'Notification system' },
  { name: 'credit', pkg: '@zucker/credit', description: 'Credit/points system' },
  { name: 'ai', pkg: '@zucker/ai', description: 'AI integration' },
  { name: 'i18n', pkg: '@zucker/i18n', description: 'Internationalization' },
  { name: 'tenant', pkg: '@zucker/tenant', description: 'Multi-tenancy' },
  { name: 'form', pkg: '@zucker/form', description: 'Dynamic form engine' },
  { name: 'monitoring', pkg: '@zucker/monitoring', description: 'System monitoring' },
];

export const initCommand = new Command('init')
  .description('Initialize a new Zucker project')
  .argument('[name]', 'Project name', 'zucker-app')
  .option('--template <template>', 'Template to use (server, admin, web)', 'server')
  .action(async (name: string, options: { template: string }) => {
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
    const monorepoTemplate = resolve(__dirname, '..', '..', '..', '..', 'templates', options.template);
    const templateDir = existsSync(monorepoTemplate) ? monorepoTemplate : null;

    if (!templateDir) {
      console.log(`  \x1b[33mNote:\x1b[0m Template "${options.template}" not found locally.`);
      console.log('  Generating minimal project scaffold instead.\n');

      // Generate a minimal scaffold
      mkdirSync(resolve(targetDir, 'src'), { recursive: true });

      // package.json
      const pkg = {
        name,
        version: '0.1.0',
        private: true,
        scripts: {
          dev: 'tsx watch src/main.ts',
          build: 'tsc',
          start: 'node dist/main.js',
        },
        dependencies: {
          '@nestjs/common': '^11.0.0',
          '@nestjs/core': '^11.0.0',
          '@nestjs/platform-express': '^11.0.0',
          '@zucker/core': 'workspace:*',
          '@zucker/common': 'workspace:*',
          '@zucker/crud': 'workspace:*',
          '@zucker/event': 'workspace:*',
          '@zucker/auth': 'workspace:*',
          'reflect-metadata': '^0.2.0',
          'rxjs': '^7.8.0',
        },
        devDependencies: {
          '@types/node': '^25.5.0',
          'tsx': '^4.0.0',
          'typescript': '^5.7.0',
        },
      };
      writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

      // tsconfig.json
      const tsconfig = {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src'],
      };
      writeFileSync(resolve(targetDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');

      // .env.local
      writeFileSync(resolve(targetDir, '.env.local'), [
        '# JWT secret — required for production',
        '# JWT_SECRET=your-secure-secret-here',
        '',
        '# Database URL — leave unset to use InMemoryAdapter',
        '# DATABASE_URL=postgresql://user:pass@localhost:5432/zucker',
        '',
      ].join('\n'));

      // Minimal main.ts
      writeFileSync(resolve(targetDir, 'src', 'main.ts'), [
        "import { NestFactory } from '@nestjs/core';",
        "import { ValidationPipe, Logger } from '@nestjs/common';",
        "import { HttpExceptionFilter } from '@zucker/common';",
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
        "import { ZuckerEventModule } from '@zucker/event';",
        "import { ZuckerCommonModule } from '@zucker/common';",
        "import { ZuckerCrudModule, InMemoryAdapter } from '@zucker/crud';",
        "import { ZuckerAuthModule } from '@zucker/auth';",
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
      filter: (src) => !src.includes('node_modules') && !src.includes('dist') && !src.includes('.turbo'),
    });

    console.log('  \x1b[32mProject created successfully!\x1b[0m\n');
    console.log('  Next steps:');
    console.log(`    cd ${name}`);
    console.log('    pnpm install');
    console.log('    pnpm dev\n');
  });
