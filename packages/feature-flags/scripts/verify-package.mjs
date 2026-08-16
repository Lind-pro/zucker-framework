import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageDirectory, '../..');
const allowDirty = process.argv.includes('--allow-dirty');
const sourceDirty = runCapture('git', ['status', '--porcelain'], repositoryRoot).trim().length > 0;

if (sourceDirty && !allowDirty) {
  throw new Error('Refusing to verify a release artifact from a dirty worktree');
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'zucker-feature-flags-package-'));

try {
  run('pnpm', ['run', 'build'], packageDirectory);
  const firstTarball = pack(join(temporaryRoot, 'pack-a'));
  const secondTarball = pack(join(temporaryRoot, 'pack-b'));
  const firstDigest = sha256(firstTarball);
  const secondDigest = sha256(secondTarball);

  if (firstDigest !== secondDigest) {
    throw new Error('Repeated package builds produced different tarball checksums');
  }

  verifyPackedManifest(firstTarball);
  verifyExternalConsumer(firstTarball);
  process.stdout.write(`Verified @zucker/feature-flags artifact sha256:${firstDigest}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function pack(outputDirectory) {
  mkdirSync(outputDirectory, { recursive: true });
  run('pnpm', ['pack', '--pack-destination', outputDirectory], packageDirectory);
  const tarball = readdirSync(outputDirectory).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack did not create a tarball');
  return join(outputDirectory, tarball);
}

function verifyPackedManifest(tarball) {
  const manifest = JSON.parse(runCapture('tar', ['-xOf', tarball, 'package/package.json']));
  if (manifest.name !== '@zucker/feature-flags' || manifest.version !== '0.1.0-rc.1') {
    throw new Error(`Unexpected packed identity: ${manifest.name}@${manifest.version}`);
  }
  if (!manifest.version.includes('-rc.')) throw new Error('Package version must be immutable');

  const listing = runCapture('tar', ['-tf', tarball]);
  for (const file of [
    'package/dist/index.js',
    'package/dist/index.mjs',
    'package/dist/index.d.ts',
  ]) {
    if (!listing.includes(file)) throw new Error(`Packed artifact is missing ${file}`);
  }
  for (const dependency of Object.values(manifest.dependencies ?? {})) {
    if (/^(workspace:|file:|link:)/.test(String(dependency))) {
      throw new Error(`Packed artifact contains a local dependency: ${dependency}`);
    }
  }
}

function verifyExternalConsumer(tarball) {
  const consumerDirectory = join(temporaryRoot, 'consumer');
  mkdirSync(consumerDirectory, { recursive: true });
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    JSON.stringify({ name: 'feature-flags-smoke', private: true, type: 'module' }),
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    consumerDirectory,
  );

  const esmSmoke = [
    "import { FeatureFlagEvaluator } from '@zucker/feature-flags';",
    "const flags = new FeatureFlagEvaluator((key) => key === 'ROLLOUT' ? 'true' : undefined);",
    "flags.register({ key: 'rollout', envKey: 'ROLLOUT', defaultValue: false });",
    "if (!flags.isEnabled('rollout')) throw new Error('ESM evaluation failed');",
  ].join('\n');
  run('node', ['--input-type=module', '--eval', esmSmoke], consumerDirectory);

  const cjsSmoke = [
    "const { FeatureFlagEvaluator } = require('@zucker/feature-flags');",
    'const flags = new FeatureFlagEvaluator();',
    "flags.register({ key: 'off', defaultValue: false });",
    "if (flags.isEnabled('off')) throw new Error('CJS evaluation failed');",
  ].join('\n');
  run('node', ['--input-type=commonjs', '--eval', cjsSmoke], consumerDirectory);

  const typeSmoke = [
    "import { FeatureFlagEvaluator, type FeatureFlagEvaluation } from '@zucker/feature-flags';",
    'const evaluator = new FeatureFlagEvaluator();',
    "const decision: FeatureFlagEvaluation = evaluator.evaluate('typed');",
    'const enabled: boolean = decision.enabled;',
    'void enabled;',
  ].join('\n');
  writeFileSync(join(consumerDirectory, 'smoke.ts'), typeSmoke);
  const tsc = resolve(repositoryRoot, 'node_modules/.bin/tsc');
  if (!existsSync(tsc)) throw new Error('TypeScript compiler is unavailable');
  run(
    tsc,
    [
      'smoke.ts',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
    ],
    consumerDirectory,
  );
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
}

function runCapture(command, args, cwd = packageDirectory) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' });
}
