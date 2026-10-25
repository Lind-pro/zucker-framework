import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProjectBundle } from '../packages/cli/tooling/project-templates.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const declarationFile = /\.d\.(?:ts|mts|cts)$/i;
const sourceFile = /\.(?:ts|tsx|mts|cts|jsx)$/i;
const sourceMapReference = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/;
const localFile = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.DS_Store)$|\.tsbuildinfo$/i;
const cacheDirectory = /(?:^|\/)(?:\.git|\.turbo|\.cache|node_modules|coverage|test-results|playwright-report)\//;
const developmentFile = /(?:^|\/)(?:\.agents|\.claude|\.github|__tests__|__mocks__|tests?|examples?|benchmarks?|docs)\/|(?:^|\/)(?:AGENTS|CLAUDE)\.md$|\.(?:spec|test)(?:\.d)?\.[cm]?[jt]sx?$|(?:^|\/)(?:tsconfig[^/]*\.json|(?:vitest|vite|eslint|jest)\.config\.[^/]+|turbo\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/i;

function exportTargets(value) {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportTargets);
}

function assertPackageEntryFiles(manifest, files) {
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const entries = new Set([manifest.main, manifest.module, manifest.types, ...bins,
    ...exportTargets(manifest.exports)].filter(Boolean));
  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, '');
    const pattern = new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`);
    if (!files.some((file) => pattern.test(file))) {
      throw new Error(`${manifest.name} is missing published entry ${entry}; build fresh artifacts before publishing`);
    }
  }
}

function assertPackageLicenseFiles(manifest, files, readFile) {
  if (manifest.license !== 'Apache-2.0') throw new Error(`${manifest.name} must declare license: Apache-2.0`);
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']) {
    if (!files.includes(name)) throw new Error(`${manifest.name} is missing ${name}; prepare package licenses before packing`);
    const content = readFile(name).toString('utf8');
    if (name !== 'THIRD_PARTY_NOTICES' && content !== readFileSync(join(rootDir, name), 'utf8')) {
      throw new Error(`${manifest.name} has stale or incomplete ${name}`);
    }
    if (name === 'THIRD_PARTY_NOTICES' && !content.startsWith(`${manifest.name}\n`)) {
      throw new Error(`${manifest.name} has missing or mismatched third-party notices`);
    }
  }
}

/** Check the actual package payload, including stale files left by older builds. */
export function assertPackageContent(packageName, files, readFile) {
  const violations = [];
  if (packageName === '@zucker-framework/cli') {
    const assets = files.find(file => file === 'dist/project-templates.json' || file === 'package/dist/project-templates.json');
    if (!assets) throw new Error('CLI is missing dist/project-templates.json; prepare generator assets before packing.');
    validateProjectBundle(JSON.parse(readFile(assets).toString('utf8')));
  }
  for (const file of files) {
    if (localFile.test(file) || cacheDirectory.test(file)) {
      violations.push(`${file}: local configuration or generated cache`);
    } else if (developmentFile.test(file)) {
      violations.push(`${file}: development-only file`);
    } else if (/\.map$/i.test(file)) {
      violations.push(`${file}: source map`);
    } else if (sourceFile.test(file) && !declarationFile.test(file)) {
      violations.push(`${file}: uncompiled source`);
    } else if (/\.(?:[cm]?js|[cm]?ts)$/i.test(file)) {
      // Inline maps embed source even when no separate .map file is present.
      if (sourceMapReference.test(readFile(file).toString('utf8'))) {
        violations.push(`${file}: sourceMappingURL reference`);
      }
    }
  }
  if (violations.length) {
    throw new Error(`${packageName} contains source material excluded from releases:\n${violations.join('\n')}`);
  }
}

export function assertTarballContent(tarball) {
  const archive = resolve(tarball);
  const files = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })
    .trim().split('\n').filter((file) => file && !file.endsWith('/'));
  const readFile = (file) => execFileSync('tar', ['-xOf', archive, '--', file], { maxBuffer: 32 * 1024 * 1024 });
  if (!files.includes('package/package.json')) throw new Error(`${archive} is missing package/package.json`);
  const manifest = JSON.parse(readFile('package/package.json').toString('utf8'));
  const relativeFiles = files.map((file) => file.replace(/^package\//, ''));
  assertPackageEntryFiles(manifest, relativeFiles);
  assertPackageLicenseFiles(manifest, relativeFiles, (file) => readFile(`package/${file}`));
  assertPackageContent(manifest.name, files, readFile);
}

export function verifyPackageDirectories(directories) {
  const failures = [];
  let fileCount = 0;
  for (const directory of directories) {
    const packageDir = resolve(directory);
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    if (manifest.private) continue;
    try {
      // No lifecycle scripts, builds, installs, tarball writes or registry access.
      const output = execFileSync(
        'npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--loglevel=error'],
        { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
      );
      const [pack] = JSON.parse(output);
      const files = pack.files.map((file) => file.path);
      // An empty package after cleanup is not a verified release artifact.
      assertPackageEntryFiles(manifest, files);
      assertPackageLicenseFiles(manifest, files, (file) => readFileSync(join(packageDir, file)));
      assertPackageContent(manifest.name, files, (file) => readFileSync(join(packageDir, file)));
      fileCount += files.length;
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (failures.length) throw new Error(failures.join('\n\n'));
  return fileCount;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--tarball') {
      if (args.length < 2) throw new Error('--tarball requires at least one archive');
      for (const tarball of args.slice(1)) assertTarballContent(tarball);
      process.stdout.write(`Package content verified: ${args.length - 1} archives\n`);
    } else {
      const directories = args.length ? args : readdirSync(join(rootDir, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(rootDir, 'packages', entry.name));
      const fileCount = verifyPackageDirectories(directories);
      process.stdout.write(`Package content verified: ${fileCount} files\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
