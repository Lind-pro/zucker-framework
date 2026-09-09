import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTarballContent } from './verify-package-content.mjs';
import { assertStaticRuntimeDependencies } from './verify-runtime-dependencies.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootManifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const installedVersion = (directory, name) => JSON.parse(readFileSync(join(rootDir, directory, 'node_modules', name, 'package.json'), 'utf8')).version;
const scaffoldCatalog = JSON.parse(readFileSync(join(rootDir, 'packages/cli/dist/release-catalog.json'), 'utf8'));
const consumerHosts = Object.fromEntries(Object.entries(scaffoldCatalog.server.dependencies).filter(([name]) => !name.startsWith('@zucker-framework/')));
const packageNames = readdirSync(join(rootDir, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !JSON.parse(readFileSync(join(rootDir, 'packages', name, 'package.json'), 'utf8')).private)
  .sort();
const workspaceReference = /^(?:workspace:|link:|file:)|^(?:\/|[A-Za-z]:\\)/;
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const explicitOutput = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const allowDirty = args.includes('--allow-dirty');
const sourceCommit = capture('git', ['rev-parse', 'HEAD']).trim();
const sourceTree = capture('git', ['rev-parse', 'HEAD^{tree}']).trim();
const sourceStatus = capture('git', ['status', '--porcelain', '--untracked-files=all']).trim();
const sourceDirty = sourceStatus.length > 0;
if (outputIndex >= 0 && !explicitOutput) throw new Error('--output requires a directory');
if (explicitOutput && sourceDirty && !allowDirty) {
  throw new Error(`Refusing to create a release bundle from a dirty worktree:\n${sourceStatus}`);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'zucker-package-artifacts-'));
const packDirectory = explicitOutput
  ? resolve(rootDir, explicitOutput)
  : join(temporaryRoot, 'packs');
const consumerDirectory = join(temporaryRoot, 'consumer');
const pnpmConsumerDirectory = join(temporaryRoot, 'pnpm-consumer');
const consumerNpmrc = join(temporaryRoot, '.npmrc');
writeFileSync(consumerNpmrc, 'registry=https://registry.npmjs.org/\n', { mode: 0o600 });
const consumerEnvironment = { ...process.env, NPM_CONFIG_USERCONFIG: consumerNpmrc };
let succeeded = false;

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
}

function capture(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    ...options,
  });
}

function readPackedManifest(tarball) {
  const json = capture('tar', ['-xOf', tarball, 'package/package.json']);
  return JSON.parse(json);
}

function assertPortableDependencies(manifest) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (workspaceReference.test(String(version))) {
        throw new Error(`${manifest.name} contains non-publishable ${field}.${name}=${version}`);
      }
    }
  }
}

function assertPublishedFiles(manifest, tarball) {
  const listing = capture('tar', ['-tf', tarball]);
  for (const entry of [manifest.main, manifest.module, manifest.types]) {
    if (entry && !listing.includes(`package/${entry.replace(/^\.\//, '')}`)) {
      throw new Error(`${manifest.name} is missing published file ${entry}`);
    }
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

try {
  if (explicitOutput && existsSync(packDirectory) && readdirSync(packDirectory).length) {
    throw new Error('Refusing to overwrite an existing release bundle; choose a new output directory');
  }
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });
  mkdirSync(pnpmConsumerDirectory, { recursive: true });

  const artifacts = packageNames.map((packageName) => {
    const packageDirectory = join(rootDir, 'packages', packageName);
    const sourceManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    // Build once before this command. Packing must not silently rebuild different bytes.
    run('pnpm', ['pack', '--pack-destination', packDirectory], {
      cwd: packageDirectory,
    });
    const filename = `${sourceManifest.name.replace('@', '').replace('/', '-')}-${sourceManifest.version}.tgz`;
    const tarball = join(packDirectory, filename);
    if (!existsSync(tarball)) {
      throw new Error(`Package tarball was not created: ${tarball}`);
    }
    const manifest = readPackedManifest(tarball);
    assertTarballContent(tarball);
    for (const file of capture('tar', ['-tf', tarball]).trim().split('\n').filter(file => file.endsWith('.mjs'))) {
      assertStaticRuntimeDependencies(manifest, capture('tar', ['-xOf', tarball, '--', file]), file);
    }
    assertPortableDependencies(manifest);
    assertPublishedFiles(manifest, tarball);
    return { filename, tarball, manifest, sha256: sha256(tarball) };
  });

  writeFileSync(
    join(packDirectory, 'release-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        sourceCommit,
        sourceTree,
        sourceDirty,
        packages: artifacts.map(({ filename, manifest, sha256: digest }) => ({
          name: manifest.name,
          version: manifest.version,
          filename,
          sha256: digest,
          dependencies: manifest.dependencies ?? {},
          peerDependencies: manifest.peerDependencies ?? {},
        })),
      },
      null,
      2,
    )}\n`,
  );

  const tarballs = artifacts.map(({ tarball }) => tarball);
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    JSON.stringify({ name: 'zucker-package-smoke', private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      ...tarballs,
      '@nestjs/common@12.0.1',
      '@nestjs/core@12.0.1',
      '@nestjs/event-emitter@12.0.0',
      '@nestjs/swagger@12.0.1',
      'bullmq@6.3.4',
      'openai@7.9.0',
      'webdav@5.10.0',
      'reflect-metadata@0.2.2',
      'rxjs@7.8.2',
    ],
    { cwd: consumerDirectory, env: consumerEnvironment },
  );

  writeFileSync(
    join(consumerDirectory, 'smoke.mjs'),
    `import { DurableWorkerRuntime, PostgresTaskRedriver, PostgresTaskSummaryReader, PostgresTaskTimelineReader, TASK_STATUSES } from '@zucker-framework/task';
import { BullMqQueueProvider } from '@zucker-framework/queue';
import { AICallWrapper } from '@zucker-framework/ai';
import { AIAccessProviderRegistry, PostgresCredentialProfileStore } from '@zucker-framework/ai-access';
import { getProcessUptime, MetricsRegistry, renderPrometheusMetrics } from '@zucker-framework/monitoring';
import { WebDavStorage } from '@zucker-framework/storage';
import { PiiFilter } from '@zucker-framework/logging';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { FeatureFlagEvaluator } from '@zucker-framework/feature-flags';
import { DurableNotificationWorker } from '@zucker-framework/notification';

if (!TASK_STATUSES.includes('QUEUED')) throw new Error('task ESM export missing');
if (typeof DurableWorkerRuntime !== 'function') throw new Error('durable worker runtime ESM export missing');
if (typeof PostgresTaskSummaryReader !== 'function') throw new Error('task summary reader ESM export missing');
if (typeof PostgresTaskTimelineReader !== 'function') throw new Error('task timeline reader ESM export missing');
if (typeof PostgresTaskRedriver !== 'function') throw new Error('task redriver ESM export missing');
if (typeof BullMqQueueProvider !== 'function') throw new Error('queue ESM export missing');
if (typeof AICallWrapper !== 'function') throw new Error('ai ESM export missing');
if (typeof AIAccessProviderRegistry !== 'function') throw new Error('ai-access registry ESM export missing');
if (typeof PostgresCredentialProfileStore !== 'function') throw new Error('ai-access PostgreSQL store ESM export missing');
const registry = new MetricsRegistry();
registry.counter('smoke_total').increment();
if (!renderPrometheusMetrics(registry).includes('smoke_total 1')) throw new Error('monitoring ESM export missing');
if (getProcessUptime(1_000, 3_450).uptimeMs !== 2_450) throw new Error('monitoring uptime ESM export missing');
if (typeof WebDavStorage !== 'function') throw new Error('storage ESM export missing');
if (new PiiFilter({ sensitiveFields: ['prompt'] }).sanitizeValue({ prompt: 'secret' }).prompt !== '[REDACTED]') throw new Error('logging ESM export missing');
if (typeof PostgresCreditOperationCoordinator !== 'function') throw new Error('credit coordinator ESM export missing');
if (typeof FeatureFlagEvaluator !== 'function') throw new Error('feature flags ESM export missing');
if (typeof DurableNotificationWorker !== 'function') throw new Error('notification ESM export missing');
`,
  );
  writeFileSync(
    join(consumerDirectory, 'smoke.cjs'),
    `const task = require('@zucker-framework/task');
const queue = require('@zucker-framework/queue');
const ai = require('@zucker-framework/ai');
const aiAccess = require('@zucker-framework/ai-access');
const monitoring = require('@zucker-framework/monitoring');
const storage = require('@zucker-framework/storage');
const logging = require('@zucker-framework/logging');
const credit = require('@zucker-framework/credit');
const featureFlags = require('@zucker-framework/feature-flags');
const notification = require('@zucker-framework/notification');

if (!task.TASK_STATUSES.includes('QUEUED')) throw new Error('task CJS export missing');
if (typeof task.DurableWorkerRuntime !== 'function') throw new Error('durable worker runtime CJS export missing');
if (typeof task.PostgresTaskSummaryReader !== 'function') throw new Error('task summary reader CJS export missing');
if (typeof task.PostgresTaskTimelineReader !== 'function') throw new Error('task timeline reader CJS export missing');
if (typeof task.PostgresTaskRedriver !== 'function') throw new Error('task redriver CJS export missing');
if (typeof queue.BullMqQueueProvider !== 'function') throw new Error('queue CJS export missing');
if (typeof ai.AICallWrapper !== 'function') throw new Error('ai CJS export missing');
if (typeof aiAccess.AIAccessProviderRegistry !== 'function') throw new Error('ai-access registry CJS export missing');
if (typeof aiAccess.PostgresCredentialProfileStore !== 'function') throw new Error('ai-access PostgreSQL store CJS export missing');
const registry = new monitoring.MetricsRegistry();
registry.counter('smoke_total').increment();
if (!monitoring.renderPrometheusMetrics(registry).includes('smoke_total 1')) throw new Error('monitoring CJS export missing');
if (monitoring.getProcessUptime(1_000, 3_450).uptimeMs !== 2_450) throw new Error('monitoring uptime CJS export missing');
if (typeof storage.WebDavStorage !== 'function') throw new Error('storage CJS export missing');
if (new logging.PiiFilter({ sensitiveFields: ['prompt'] }).sanitizeValue({ prompt: 'secret' }).prompt !== '[REDACTED]') throw new Error('logging CJS export missing');
if (typeof credit.PostgresCreditOperationCoordinator !== 'function') throw new Error('credit coordinator CJS export missing');
if (typeof featureFlags.FeatureFlagEvaluator !== 'function') throw new Error('feature flags CJS export missing');
if (typeof notification.DurableNotificationWorker !== 'function') throw new Error('notification CJS export missing');
`,
  );
  run('node', ['smoke.mjs'], { cwd: consumerDirectory });
  run('node', ['smoke.cjs'], { cwd: consumerDirectory });

  writeFileSync(
    join(pnpmConsumerDirectory, 'package.json'),
    JSON.stringify({
      name: 'zucker-package-pnpm-smoke',
      private: true,
      type: 'module',
      packageManager: rootManifest.packageManager,
      dependencies: Object.fromEntries(
        artifacts.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]),
      ),
      devDependencies: {
        ...consumerHosts,
        typescript: installedVersion('.', 'typescript'),
        '@types/node': installedVersion('packages/core', '@types/node'),
        '@types/express': installedVersion('packages/common', '@types/express'),
        '@types/react': installedVersion('templates/admin', '@types/react'),
        '@types/react-dom': installedVersion('templates/admin', '@types/react-dom'),
        react: installedVersion('templates/admin', 'react'),
        'react-dom': installedVersion('templates/admin', 'react-dom'),
        antd: installedVersion('templates/admin', 'antd'),
        '@ant-design/icons': installedVersion('templates/admin', '@ant-design/icons'),
        '@nestjs/common': '12.0.1',
        '@nestjs/core': '12.0.1',
        '@nestjs/event-emitter': '12.0.0',
        bullmq: '6.3.4',
        openai: '7.9.0',
        webdav: '5.10.0',
        'reflect-metadata': '0.2.2',
        rxjs: '7.8.2',
      },
    }),
  );
  writeFileSync(
    join(pnpmConsumerDirectory, 'pnpm-workspace.yaml'),
    `packages:\n  - .\n\noverrides:\n${artifacts
      .map(
        ({ manifest, tarball }) =>
          `  ${JSON.stringify(manifest.name)}: ${JSON.stringify(`file:${tarball}`)}`,
      )
      .join('\n')}\n`,
  );
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: pnpmConsumerDirectory,
    env: consumerEnvironment,
  });
  run('pnpm', ['peers', 'check'], { cwd: pnpmConsumerDirectory });
  writeFileSync(
    join(pnpmConsumerDirectory, 'smoke.mjs'),
    `import { DurableWorkerRuntime, PostgresTaskRedriver, PostgresTaskTimelineReader, TASK_STATUSES } from '@zucker-framework/task';
import { BullMqQueueProvider } from '@zucker-framework/queue';
import { AICallWrapper } from '@zucker-framework/ai';
import { AIAccessProviderRegistry, PostgresCredentialProfileStore } from '@zucker-framework/ai-access';
import { getProcessUptime, MetricsRegistry, renderPrometheusMetrics } from '@zucker-framework/monitoring';
import { WebDavStorage } from '@zucker-framework/storage';
import { PiiFilter } from '@zucker-framework/logging';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { FeatureFlagEvaluator } from '@zucker-framework/feature-flags';
import { DurableNotificationWorker } from '@zucker-framework/notification';

if (!TASK_STATUSES.includes('QUEUED')) throw new Error('task pnpm export missing');
if (typeof DurableWorkerRuntime !== 'function') throw new Error('durable worker runtime pnpm export missing');
if (typeof PostgresTaskTimelineReader !== 'function') throw new Error('task timeline reader pnpm export missing');
if (typeof PostgresTaskRedriver !== 'function') throw new Error('task redriver pnpm export missing');
if (typeof BullMqQueueProvider !== 'function') throw new Error('queue pnpm export missing');
if (typeof AICallWrapper !== 'function') throw new Error('ai pnpm export missing');
if (typeof AIAccessProviderRegistry !== 'function') throw new Error('ai-access registry pnpm export missing');
if (typeof PostgresCredentialProfileStore !== 'function') throw new Error('ai-access PostgreSQL store pnpm export missing');
const registry = new MetricsRegistry();
registry.counter('smoke_total').increment();
if (!renderPrometheusMetrics(registry).includes('smoke_total 1')) throw new Error('monitoring pnpm export missing');
if (getProcessUptime(1_000, 3_450).uptimeMs !== 2_450) throw new Error('monitoring uptime pnpm export missing');
if (typeof WebDavStorage !== 'function') throw new Error('storage pnpm export missing');
if (new PiiFilter({ sensitiveFields: ['prompt'] }).sanitizeValue({ prompt: 'secret' }).prompt !== '[REDACTED]') throw new Error('logging pnpm export missing');
if (typeof PostgresCreditOperationCoordinator !== 'function') throw new Error('credit coordinator pnpm export missing');
if (typeof FeatureFlagEvaluator !== 'function') throw new Error('feature flags pnpm export missing');
if (typeof DurableNotificationWorker !== 'function') throw new Error('notification pnpm export missing');
`,
  );
  run('node', ['smoke.mjs'], { cwd: pnpmConsumerDirectory });
  run('node', [join(rootDir, 'scripts/verify-consumer-contracts.mjs'), pnpmConsumerDirectory,
    join(packDirectory, 'consumer-verification.json')]);
  succeeded = true;
  process.stdout.write(`Package artifact verification passed: ${packDirectory}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (explicitOutput && !succeeded) process.stderr.write(`Release verification did not complete; files retained at ${packDirectory}\n`);
}
