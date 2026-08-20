import { execFileSync, spawnSync } from 'node:child_process';
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
const sourceManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
const allowDirty = process.argv.includes('--allow-dirty');
const sourceDirty = runCapture('git', ['status', '--porcelain'], repositoryRoot).trim().length > 0;

if (sourceDirty && !allowDirty) {
  throw new Error('Refusing to verify a release artifact from a dirty worktree');
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'zucker-storage-package-'));

try {
  run('pnpm', ['run', 'build'], packageDirectory);
  const firstTarball = pack(join(temporaryRoot, 'pack-a'));
  const secondTarball = pack(join(temporaryRoot, 'pack-b'));
  const firstDigest = sha256(firstTarball);
  const secondDigest = sha256(secondTarball);

  if (firstDigest !== secondDigest) {
    throw new Error('Repeated storage package builds produced different tarball checksums');
  }

  verifyPackedManifest(firstTarball);
  verifyExternalConsumer(firstTarball);
  process.stdout.write(`Verified @zucker/storage artifact sha256:${firstDigest}\n`);
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
  if (manifest.name !== sourceManifest.name || manifest.version !== sourceManifest.version) {
    throw new Error(`Unexpected packed identity: ${manifest.name}@${manifest.version}`);
  }
  if (!manifest.version.includes('-rc.')) throw new Error('Package version must be immutable');
  if (manifest.scripts?.['canary:r2'] !== 'node scripts/r2-storage-canary.mjs') {
    throw new Error('Packed R2 canary must execute the published script without rebuilding source');
  }

  const listing = runCapture('tar', ['-tf', tarball]);
  for (const file of [
    'package/dist/index.js',
    'package/dist/index.mjs',
    'package/dist/index.d.ts',
    'package/scripts/r2-storage-canary.mjs',
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
    JSON.stringify({ name: 'storage-package-smoke', private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball,
      '@nestjs/common@^11.0.0',
      '@nestjs/core@^11.0.0',
      'webdav@^5.0.0',
      'reflect-metadata@^0.2.0',
      'rxjs@^7.8.0',
    ],
    consumerDirectory,
  );

  const esmSmoke = [
    "import { S3Storage } from '@zucker/storage';",
    "if (typeof S3Storage !== 'function') throw new Error('ESM export missing');",
  ].join('\n');
  run('node', ['--input-type=module', '--eval', esmSmoke], consumerDirectory);

  const cjsSmoke = [
    "const { S3Storage } = require('@zucker/storage');",
    "if (typeof S3Storage !== 'function') throw new Error('CJS export missing');",
  ].join('\n');
  run('node', ['--input-type=commonjs', '--eval', cjsSmoke], consumerDirectory);

  const typeSmoke = [
    "import type { S3ObjectAclMode, S3StorageOptions } from '@zucker/storage';",
    "const objectAclMode: S3ObjectAclMode = 'none';",
    'const options: S3StorageOptions = {',
    "  accessKeyId: 'test',",
    "  secretAccessKey: 'test',",
    "  bucket: 'test',",
    '  objectAclMode,',
    "  uploadUrlMode: 'public-only',",
    '};',
    'void options;',
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

  verifyPublishedCanaryGuard(consumerDirectory);
}

function verifyPublishedCanaryGuard(consumerDirectory) {
  const script = join(
    consumerDirectory,
    'node_modules',
    '@zucker',
    'storage',
    'scripts',
    'r2-storage-canary.mjs',
  );
  if (!existsSync(script)) throw new Error('Installed package is missing the R2 canary script');

  const environment = { ...process.env };
  for (const key of [
    'R2_CANARY',
    'R2_ENDPOINT',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
  ]) {
    delete environment[key];
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: consumerDirectory,
    encoding: 'utf8',
    env: environment,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0 || !output.includes('Set R2_CANARY=1')) {
    throw new Error('Published R2 canary did not enforce its explicit opt-in guard');
  }
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
