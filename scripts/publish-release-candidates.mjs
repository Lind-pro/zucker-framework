import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allowDirty = args.includes('--allow-dirty');
const bundleDir = resolve(rootDir, option('--bundle') ?? 'artifacts/rc');
const registry = option('--registry') ?? process.env.PACKAGE_REGISTRY_URL;
const distTag = option('--tag') ?? process.env.PACKAGE_DIST_TAG ?? 'rc';
const access = option('--access') ?? process.env.PACKAGE_ACCESS ?? 'restricted';
const manifestPath = join(bundleDir, 'release-manifest.json');

function option(name) {
  const exactIndex = args.indexOf(name);
  if (exactIndex >= 0) return args[exactIndex + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sha1(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}

if (!existsSync(manifestPath)) {
  throw new Error(`Release manifest not found: ${manifestPath}`);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (
  manifest.schemaVersion !== 2 ||
  !Array.isArray(manifest.packages) ||
  !/^[0-9a-f]{40,64}$/.test(manifest.sourceCommit) ||
  !/^[0-9a-f]{40,64}$/.test(manifest.sourceTree) ||
  typeof manifest.sourceDirty !== 'boolean'
) {
  throw new Error('Unsupported release manifest');
}
if (manifest.sourceDirty && !(dryRun && allowDirty)) {
  throw new Error('Refusing to publish a bundle produced from a dirty worktree');
}
if (!registry) throw new Error('PACKAGE_REGISTRY_URL or --registry is required');
const registryUrl = new URL(registry);
if (registryUrl.protocol !== 'https:' && registryUrl.hostname !== 'localhost') {
  throw new Error('Package registry must use HTTPS unless it is localhost');
}
if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
  throw new Error('NODE_AUTH_TOKEN is required for a real publish');
}
const checkoutCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();
const checkoutTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();
const checkoutDirty =
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).trim().length > 0;
if (checkoutCommit !== manifest.sourceCommit || checkoutTree !== manifest.sourceTree) {
  throw new Error('Release bundle source does not match the current framework checkout');
}
if (checkoutDirty && !(dryRun && allowDirty)) {
  throw new Error('Refusing to publish from a dirty framework checkout');
}

const artifacts = manifest.packages.map((artifact) => {
  const tarball = join(bundleDir, artifact.filename);
  if (!existsSync(tarball)) throw new Error(`Missing release artifact: ${artifact.filename}`);
  if (sha256(tarball) !== artifact.sha256) {
    throw new Error(`Checksum mismatch: ${artifact.filename}`);
  }
  return { ...artifact, tarball, sha1: sha1(tarball) };
});

const npmConfigDirectory = mkdtempSync(join(tmpdir(), 'zucker-npm-publish-'));
const npmConfig = join(npmConfigDirectory, '.npmrc');
try {
  if (!dryRun) {
    const normalizedRegistry = registry.endsWith('/') ? registry : `${registry}/`;
    const authPath = `${registryUrl.host}${registryUrl.pathname}`.replace(/\/?$/, '/');
    writeFileSync(
      npmConfig,
      `@zucker:registry=${normalizedRegistry}\n//${authPath}:_authToken=\${NODE_AUTH_TOKEN}\n`,
      { mode: 0o600 },
    );
  }

  const npmEnvironment = dryRun
    ? process.env
    : { ...process.env, NPM_CONFIG_USERCONFIG: npmConfig };
  const alreadyPublished = new Set();
  if (!dryRun) {
    for (const artifact of artifacts) {
      const publishedSha1 = publishedShasum(artifact, registry, npmEnvironment, npmConfigDirectory);
      if (!publishedSha1) continue;
      if (publishedSha1 !== artifact.sha1) {
        throw new Error(
          `Immutable version conflict: ${artifact.name}@${artifact.version} already exists with a different checksum`,
        );
      }
      alreadyPublished.add(`${artifact.name}@${artifact.version}`);
    }
  }

  for (const artifact of artifacts) {
    const packageId = `${artifact.name}@${artifact.version}`;
    if (alreadyPublished.has(packageId)) {
      process.stdout.write(`Skipping already published immutable artifact ${packageId}\n`);
      continue;
    }
    const commandArgs = [
      'publish',
      artifact.tarball,
      '--registry',
      registry,
      '--tag',
      distTag,
      '--access',
      access,
    ];
    if (dryRun) commandArgs.push('--dry-run');
    process.stdout.write(
      `${dryRun ? 'Checking' : 'Publishing'} ${artifact.name}@${artifact.version} to ${registry}\n`,
    );
    execFileSync('npm', commandArgs, {
      cwd: npmConfigDirectory,
      encoding: 'utf8',
      stdio: 'inherit',
      env: npmEnvironment,
    });
    if (!dryRun) {
      const publishedSha1 = publishedShasum(artifact, registry, npmEnvironment, npmConfigDirectory);
      if (publishedSha1 !== artifact.sha1) {
        throw new Error(`Registry checksum verification failed after publishing ${packageId}`);
      }
    }
  }
} finally {
  rmSync(npmConfigDirectory, { recursive: true, force: true });
}

function publishedShasum(artifact, registry, env, cwd) {
  try {
    const output = execFileSync(
      'npm',
      [
        'view',
        `${artifact.name}@${artifact.version}`,
        'dist.shasum',
        '--json',
        '--registry',
        registry,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env },
    );
    const value = JSON.parse(output);
    return typeof value === 'string' ? value : undefined;
  } catch (error) {
    const details = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    if (/E404|404 Not Found|not found/i.test(details)) return undefined;
    throw new Error(`Unable to inspect ${artifact.name}@${artifact.version} before publishing`, {
      cause: error,
    });
  }
}
