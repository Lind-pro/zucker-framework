import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageNames = [
  'core',
  'task',
  'queue',
  'ai-access',
  'ai',
  'cli',
  'monitoring',
  'storage',
  'logging',
  'credit',
];
const workspaceReference = /^(?:workspace:|link:|file:)|^(?:\/|[A-Za-z]:\\)/;
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const explicitOutput = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const allowDirty = args.includes('--allow-dirty');
const sourceCommit = capture('git', ['rev-parse', 'HEAD']).trim();
const sourceTree = capture('git', ['rev-parse', 'HEAD^{tree}']).trim();
const sourceDirty =
  capture('git', ['status', '--porcelain', '--untracked-files=all']).trim().length > 0;
if (outputIndex >= 0 && !explicitOutput) throw new Error('--output requires a directory');
if (explicitOutput && sourceDirty && !allowDirty) {
  throw new Error('Refusing to create a release bundle from a dirty worktree');
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'zucker-package-artifacts-'));
const packDirectory = explicitOutput
  ? resolve(rootDir, explicitOutput)
  : join(temporaryRoot, 'packs');
const consumerDirectory = join(temporaryRoot, 'consumer');
const pnpmConsumerDirectory = join(temporaryRoot, 'pnpm-consumer');
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
  if (explicitOutput) rmSync(packDirectory, { recursive: true, force: true });
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });
  mkdirSync(pnpmConsumerDirectory, { recursive: true });

  const artifacts = packageNames.map((packageName) => {
    const packageDirectory = join(rootDir, 'packages', packageName);
    const sourceManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    if (!sourceManifest.version.includes('-rc.')) {
      throw new Error(`${sourceManifest.name} must use an immutable RC version`);
    }
    run('pnpm', ['--filter', sourceManifest.name, 'clean']);
    run('pnpm', ['--filter', sourceManifest.name, 'build']);
    run('pnpm', ['pack', '--pack-destination', packDirectory], {
      cwd: packageDirectory,
    });
    const filename = `${sourceManifest.name.replace('@', '').replace('/', '-')}-${sourceManifest.version}.tgz`;
    const tarball = join(packDirectory, filename);
    if (!existsSync(tarball)) {
      throw new Error(`Package tarball was not created: ${tarball}`);
    }
    const manifest = readPackedManifest(tarball);
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
      '@nestjs/common@^11.0.0',
      '@nestjs/core@^11.0.0',
      '@nestjs/event-emitter@^3.0.0',
      '@nestjs/swagger@^11.0.0',
      'openai@^6.34.0',
      'webdav@^5.0.0',
      'reflect-metadata@^0.2.0',
      'rxjs@^7.8.0',
    ],
    { cwd: consumerDirectory },
  );

  writeFileSync(
    join(consumerDirectory, 'smoke.mjs'),
    `import { DurableWorkerRuntime, PostgresTaskRedriver, PostgresTaskSummaryReader, PostgresTaskTimelineReader, TASK_STATUSES } from '@zucker/task';
import { BullMqQueueProvider } from '@zucker/queue';
import { AICallWrapper } from '@zucker/ai';
import { AIAccessProviderRegistry, PostgresCredentialProfileStore } from '@zucker/ai-access';
import { MetricsRegistry, renderPrometheusMetrics } from '@zucker/monitoring';
import { WebDavStorage } from '@zucker/storage';
import { PiiFilter } from '@zucker/logging';
import { PostgresCreditOperationCoordinator } from '@zucker/credit';

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
if (typeof WebDavStorage !== 'function') throw new Error('storage ESM export missing');
if (new PiiFilter({ sensitiveFields: ['prompt'] }).sanitizeValue({ prompt: 'secret' }).prompt !== '[REDACTED]') throw new Error('logging ESM export missing');
if (typeof PostgresCreditOperationCoordinator !== 'function') throw new Error('credit coordinator ESM export missing');
`,
  );
  writeFileSync(
    join(consumerDirectory, 'smoke.cjs'),
    `const task = require('@zucker/task');
const queue = require('@zucker/queue');
const ai = require('@zucker/ai');
const aiAccess = require('@zucker/ai-access');
const monitoring = require('@zucker/monitoring');
const storage = require('@zucker/storage');
const logging = require('@zucker/logging');
const credit = require('@zucker/credit');

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
if (typeof storage.WebDavStorage !== 'function') throw new Error('storage CJS export missing');
if (new logging.PiiFilter({ sensitiveFields: ['prompt'] }).sanitizeValue({ prompt: 'secret' }).prompt !== '[REDACTED]') throw new Error('logging CJS export missing');
if (typeof credit.PostgresCreditOperationCoordinator !== 'function') throw new Error('credit coordinator CJS export missing');
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
      dependencies: Object.fromEntries(
        artifacts.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]),
      ),
      pnpm: {
        overrides: Object.fromEntries(
          artifacts.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]),
        ),
      },
      devDependencies: {
        '@nestjs/common': '^11.0.0',
        '@nestjs/core': '^11.0.0',
        '@nestjs/event-emitter': '^3.0.0',
        bullmq: '^5.48.1',
        openai: '^6.34.0',
        webdav: '^5.0.0',
        'reflect-metadata': '^0.2.0',
        rxjs: '^7.8.0',
      },
    }),
  );
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: pnpmConsumerDirectory,
  });
  writeFileSync(
    join(pnpmConsumerDirectory, 'smoke.mjs'),
    `import { DurableWorkerRuntime, PostgresTaskRedriver, PostgresTaskTimelineReader, TASK_STATUSES } from '@zucker/task';
import { BullMqQueueProvider } from '@zucker/queue';
import { AICallWrapper } from '@zucker/ai';
import { AIAccessProviderRegistry, PostgresCredentialProfileStore } from '@zucker/ai-access';
import { MetricsRegistry, renderPrometheusMetrics } from '@zucker/monitoring';
import { WebDavStorage } from '@zucker/storage';
import { PiiFilter } from '@zucker/logging';
import { PostgresCreditOperationCoordinator } from '@zucker/credit';

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
if (typeof WebDavStorage !== 'function') throw new Error('storage pnpm export missing');
if (new PiiFilter({ sensitiveFields: ['prompt'] }).sanitizeValue({ prompt: 'secret' }).prompt !== '[REDACTED]') throw new Error('logging pnpm export missing');
if (typeof PostgresCreditOperationCoordinator !== 'function') throw new Error('credit coordinator pnpm export missing');
`,
  );
  run('node', ['smoke.mjs'], { cwd: pnpmConsumerDirectory });
  succeeded = true;
  process.stdout.write(`Package artifact verification passed: ${packDirectory}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (explicitOutput && !succeeded) {
    rmSync(packDirectory, { recursive: true, force: true });
  }
}
