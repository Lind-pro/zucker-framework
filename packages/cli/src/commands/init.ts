import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, readFileSync, lstatSync } from 'fs';
import { resolve, join } from 'path';
import { randomBytes } from 'node:crypto';
import { frameworkCheckoutRoot } from './checkout';
import { collectTemplateAssets, validateTemplateAssets, writeTemplateAssets } from '../../tooling/project-templates.mjs';
import { assertReleasedVersions, installInstructions, pinReleasedVersions, readProjectBundle, readReleaseCatalog } from './project-files';

function createFullServerEnvironment(targetDir: string): void {
  let environment = readFileSync(join(targetDir, '.env.example'), 'utf8');
  // Authentication and stored provider settings have independent key material and rotation policies.
  for (const name of ['JWT_SECRET', 'CONFIG_ENCRYPTION_KEY']) {
    const assignment = `${name}=${randomBytes(32).toString('hex')}`;
    const existing = new RegExp(`^${name}=.*$`, 'gm');
    environment = existing.test(environment) ? environment.replace(existing, assignment)
      : `${environment.trimEnd()}\n${assignment}\n`;
  }
  writeFileSync(join(targetDir, '.env'), environment, { mode: 0o600, flag: 'wx' });
}

export function createInitCommand(runtimeDirectory?: string, workingDirectory?: string) {
  return new Command('init')
  .description('Initialize a new Zucker project')
  .argument('[name]', 'Project name', 'zucker-app')
  .option('--template <template>', 'Template to use (server, server-full, admin, web)', 'server')
  .action(async (name: string, options: { template: string }) => {
    if (!['server', 'server-full', 'admin', 'web'].includes(options.template)) {
      throw new Error(`Unsupported template: ${options.template}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Project name must use lowercase letters, digits, dots, underscores or hyphens.');
    const runtime = runtimeDirectory ?? __dirname;
    const catalog = readReleaseCatalog(runtime);
    const bundle = readProjectBundle(runtime);
    const targetDir = resolve(workingDirectory ?? process.cwd(), name);

    console.log(`\n  Initializing Zucker project: ${name}`);
    console.log(`  Template: ${options.template}`);
    console.log(`  Directory: ${targetDir}\n`);

    // Check if directory already exists
    if (lstatSync(targetDir, { throwIfNoEntry: false })) {
      throw new Error(`Directory "${name}" already exists.`);
    }

    // Explicit bundled templates always use the CLI payload; nearby checkouts cannot change them.
    // Preserve the existing Server skeleton/full-checkout behavior for compatibility.
    // Only a real framework checkout (<root>/packages/cli/dist) may supply the full Server template;
    // an installed CLI never reads `node_modules/templates/...`.
    const checkoutRoot = frameworkCheckoutRoot(runtime);
    const monorepoTemplate = checkoutRoot ? resolve(checkoutRoot, 'templates', options.template) : null;
    const packaged = options.template === 'admin' || options.template === 'web' || options.template === 'server-full'
      ? bundle.templates[options.template] : undefined;
    const templateDir = options.template === 'server' && monorepoTemplate && existsSync(monorepoTemplate) ? monorepoTemplate : null;
    const assets = packaged ?? (templateDir ? collectTemplateAssets(templateDir) : null);

    if (!assets) {
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
        engines: { node: catalog.runtime?.node ?? '>=22.22.0' },
        ...(catalog.runtime?.packageManager ? { packageManager: catalog.runtime.packageManager } : {}),
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
      writeFileSync(resolve(targetDir, '.gitignore'), 'node_modules/\ndist/\n.env*\n!.env.example\n');
      writeFileSync(resolve(targetDir, '.env'), `JWT_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });

      // Document configuration without exposing the generated local secret.
      writeFileSync(resolve(targetDir, '.env.example'), [
        '# JWT secret — required for production',
        '# JWT_SECRET=your-secure-secret-here',
        '',
        '# Database URL — reserved for an application-owned persistent adapter',
        '# This minimal scaffold always uses InMemoryAdapter until its module wiring is changed.',
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

      installInstructions(targetDir, bundle);
      writeFileSync(join(targetDir, 'README.md'), '# ' + name + '\n\nMinimal Server scaffold. The memory adapter is a disposable demonstration, not persistent storage. Configure and verify the application-owned database and auth policies before real use.\n\nCommands: `pnpm install`, `pnpm dev`. Read `AGENTS.md` before extending the application.\n');
      console.log('  \x1b[32mProject scaffolded successfully!\x1b[0m\n');
      console.log('  Next steps:');
      console.log(`    cd ${name}`);
      console.log('    pnpm install');
      console.log('    pnpm dev\n');
      return;
    }

    // Copy template
    console.log('  Preparing project files...\n');
    {
      // Validate dependency catalog before creating any consumer files.
      validateTemplateAssets(assets);
      assertReleasedVersions(JSON.parse(Buffer.from(assets['package.json'], 'base64').toString('utf8')), catalog);
      mkdirSync(targetDir);
      writeTemplateAssets(assets, targetDir);
    }

    const copiedManifestPath = resolve(targetDir, 'package.json');
    const copiedManifest = JSON.parse(readFileSync(copiedManifestPath, 'utf8')) as Record<string, unknown>;
    copiedManifest.name = name;
    if (catalog.runtime?.packageManager) copiedManifest.packageManager = catalog.runtime.packageManager;
    if (catalog.runtime?.node) copiedManifest.engines = { ...(copiedManifest.engines as object ?? {}), node: catalog.runtime.node };
    pinReleasedVersions(copiedManifest, catalog);
    writeFileSync(copiedManifestPath, JSON.stringify(copiedManifest, null, 2) + '\n');

    if (options.template === 'server-full') createFullServerEnvironment(targetDir);
    installInstructions(targetDir, bundle);
    console.log('  \x1b[32mProject created successfully!\x1b[0m\n');
    console.log('  Next steps:');
    console.log(`    cd ${name}`);
    console.log('    pnpm install');
    if (options.template === 'server-full') {
      console.log("    Configure the generated private .env (PostgreSQL, origins and SMTP; JWT secret is already generated).");
      console.log('    pnpm prisma:generate');
      console.log('    pnpm db:migrate');
    }
    console.log('    pnpm dev\n');
  });

}

export const initCommand = createInitCommand();
