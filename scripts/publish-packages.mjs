import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTarballContent } from './verify-package-content.mjs';
import { orderReleasePackages } from './release-graph.mjs';
import { verifyPreparedRelease } from './release-github.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--publish') && args.includes('--dry-run')) throw new Error('Choose --publish or --dry-run, not both');
if (args.includes('--publish') && args.includes('--plan')) throw new Error('--plan cannot upload packages');
const dryRun = !args.includes('--publish');
const planOnly = args.includes('--plan');
const allowDirty = args.includes('--allow-dirty');
const bundleDir = resolve(rootDir, option('--bundle') ?? 'artifacts/release');
const registry = option('--registry') ?? process.env.PACKAGE_REGISTRY_URL ?? 'https://registry.npmjs.org/';
const distTag = option('--tag') ?? process.env.PACKAGE_DIST_TAG ?? 'latest';
const access = option('--access') ?? process.env.PACKAGE_ACCESS ?? 'public';
const manifestPath = join(bundleDir, 'release-manifest.json');
const auth = option('--auth') ?? 'auto';
if (!['auto', 'session', 'token', 'oidc'].includes(auth)) throw new Error('Unknown publishing authentication mode');

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
if (!['public', 'restricted'].includes(access)) throw new Error('Package access must be public or restricted');
if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(distTag)) throw new Error('Invalid distribution tag');
const registryUrl = new URL(registry);
if (registryUrl.username || registryUrl.password || registryUrl.search || registryUrl.hash) {
  throw new Error('Registry URLs must not contain credentials, query parameters or fragments');
}
if (registryUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(registryUrl.hostname)) {
  throw new Error('Package registry must use HTTPS unless it is localhost');
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

const packageIds = new Set();
const artifacts = orderReleasePackages(manifest.packages.map((artifact) => {
  if (!/^@zucker-framework\/[a-z0-9][a-z0-9._-]*$/.test(artifact.name)
    || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(artifact.version)
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || artifact.filename !== `${artifact.name.replace('@', '').replace('/', '-')}-${artifact.version}.tgz`) {
    throw new Error('Invalid package identity or archive filename in release manifest');
  }
  const id = `${artifact.name}@${artifact.version}`;
  if (distTag === 'latest' && artifact.version.split('+')[0].includes('-')) {
    throw new Error(`Prerelease packages cannot use the latest tag: ${id}`);
  }
  if (packageIds.has(id)) throw new Error(`Duplicate release package: ${id}`);
  packageIds.add(id);
  const tarball = join(bundleDir, artifact.filename);
  if (!existsSync(tarball)) throw new Error(`Missing release artifact: ${artifact.filename}`);
  if (sha256(tarball) !== artifact.sha256) {
    throw new Error(`Checksum mismatch: ${artifact.filename}`);
  }
  assertTarballContent(tarball);
  const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, '--', 'package/package.json'], { encoding: 'utf8' }));
  if (packed.name !== artifact.name || packed.version !== artifact.version) throw new Error(`Archive identity mismatch: ${artifact.filename}`);
  if (packed.publishConfig?.access && packed.publishConfig.access !== access) throw new Error(`Archive access policy differs from requested access: ${artifact.name}`);
  if (packed.publishConfig?.registry && new URL(packed.publishConfig.registry).href.replace(/\/$/, '') !== registryUrl.href.replace(/\/$/, '')) {
    throw new Error(`Archive registry differs from requested registry: ${artifact.name}`);
  }
  let releaseDependencies = [];
  if (packed.name === '@zucker-framework/cli') {
    const catalog = JSON.parse(execFileSync('tar', ['-xOf', tarball, '--', 'package/dist/release-catalog.json'], { encoding: 'utf8' }));
    if (!catalog.versions || typeof catalog.versions !== 'object') throw new Error('CLI release catalog is missing');
    // These are scaffold targets, not runtime dependencies to install with CLI.
    releaseDependencies = Object.keys(catalog.versions).filter((name) => name !== packed.name);
  }
  return { ...artifact, dependencies: packed.dependencies, peerDependencies: packed.peerDependencies,
    optionalDependencies: packed.optionalDependencies, releaseDependencies, tarball, sha1: sha1(tarball) };
}));

if (planOnly) {
  process.stdout.write(`${JSON.stringify({ sourceCommit: manifest.sourceCommit, sourceDirty: manifest.sourceDirty,
    manifestSha256: sha256(manifestPath), registry, distTag,
    packages: artifacts.map(({ name, version, filename }) => ({ name, version, filename })) }, null, 2)}\n`);
  process.exit(0);
}

let authentication = auth;
if (!dryRun) {
  const approvedHash = option('--manifest-sha256');
  if (!approvedHash || !/^[a-f0-9]{64}$/.test(approvedHash) || approvedHash !== sha256(manifestPath)) {
    throw new Error('A real upload requires the approved --manifest-sha256 from the preparation workflow');
  }
  const receipt = JSON.parse(readFileSync(join(bundleDir, 'release-receipt.json'), 'utf8'));
  if (receipt.distTag !== distTag || receipt.registry.replace(/\/$/, '') !== registryUrl.href.replace(/\/$/, '')) {
    throw new Error('Registry or distribution tag differs from the prepared release');
  }
  verifyPreparedRelease(receipt, { commit: manifest.sourceCommit, manifestSha256: approvedHash });
  if (authentication === 'auto') {
    authentication = process.env.GITHUB_ACTIONS === 'true' && process.env.ACTIONS_ID_TOKEN_REQUEST_URL
      ? 'oidc' : process.env.NODE_AUTH_TOKEN ? 'token' : 'session';
  }
  if (authentication === 'token' && !process.env.NODE_AUTH_TOKEN) throw new Error('Token authentication requires NODE_AUTH_TOKEN');
  if (authentication === 'oidc' && (process.env.GITHUB_ACTIONS !== 'true'
    || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    || process.env.GITHUB_SHA !== manifest.sourceCommit)) {
    throw new Error('OIDC publishing requires a GitHub-hosted workflow running at the exact release commit');
  }
}

const npmConfigDirectory = mkdtempSync(join(tmpdir(), 'zucker-npm-publish-'));
const npmConfig = join(npmConfigDirectory, '.npmrc');
try {
  writeFileSync(npmConfig, `@zucker-framework:registry=${registryUrl.href}\n`, { mode: 0o600 });
  if (!dryRun && authentication === 'token') {
    const normalizedRegistry = registry.endsWith('/') ? registry : `${registry}/`;
    const authPath = `${registryUrl.host}${registryUrl.pathname}`.replace(/\/?$/, '/');
    writeFileSync(
      npmConfig,
      `@zucker-framework:registry=${normalizedRegistry}\n//${authPath}:_authToken=\${NODE_AUTH_TOKEN}\n`,
      { mode: 0o600 },
    );
  }

  // CI supplies a token through the environment. Local uploads may use an
  // existing npm login without reading or copying its credentials here.
  const npmEnvironment = dryRun || authentication === 'token' || authentication === 'oidc'
    ? { ...process.env, NPM_CONFIG_USERCONFIG: npmConfig }
    : { ...process.env };
  if (authentication === 'oidc') {
    delete npmEnvironment.NODE_AUTH_TOKEN;
    delete npmEnvironment.NPM_TOKEN;
    const globalConfig = join(npmConfigDirectory, 'global.npmrc');
    writeFileSync(globalConfig, '');
    npmEnvironment.NPM_CONFIG_GLOBALCONFIG = globalConfig;
  }
  const alreadyPublished = new Set();
  if (!dryRun) {
    if (authentication === 'oidc') {
      const version = execFileSync('npm', ['--version'], { encoding: 'utf8', env: npmEnvironment }).trim();
      const [major, minor, patch] = version.split('.').map(Number);
      if (!(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))))) {
        throw new Error('OIDC publishing requires npm >= 11.5.1');
      }
      // OIDC tokens are exchanged only by npm publish; npm whoami cannot test them.
    } else {
      execFileSync('npm', ['whoami', '--registry', registry], {
        cwd: npmConfigDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: npmEnvironment,
      });
    }
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
  if (!dryRun) {
    // A matching existing tarball does not prove the requested dist-tag still
    // selects it. Check the entire batch, including packages skipped on retry.
    for (const artifact of artifacts) {
      const tags = JSON.parse(execFileSync('npm', ['view', artifact.name, 'dist-tags', '--json', '--registry', registry], {
        cwd: npmConfigDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: npmEnvironment,
      }));
      if (tags[distTag] !== artifact.version) {
        throw new Error(`Registry tag verification failed: ${artifact.name}@${distTag} does not select ${artifact.version}`);
      }
    }
    writeFileSync(join(bundleDir, 'registry-verification.json'), `${JSON.stringify({ sourceCommit: manifest.sourceCommit,
      manifestSha256: sha256(manifestPath), registry, distTag,
      packages: artifacts.map(({ name, version, sha1: digest }) => ({ name, version, sha1: digest })) }, null, 2)}\n`);
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
