import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { githubFixture, releaseReceipt } from './release-test-fixtures.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(rootDir, 'scripts/publish-packages.mjs');

function fixture(name = '@zucker-framework/publish-fixture', version = '1.0.0') {
  const directory = mkdtempSync(join(tmpdir(), 'zucker-publish-policy-'));
  const packageDir = join(directory, 'package');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name, version, license: 'Apache-2.0', main: 'dist/index.js',
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
  }));
  writeFileSync(join(packageDir, 'dist/index.js'), 'module.exports = {};\n');
  for (const file of ['LICENSE', 'NOTICE']) writeFileSync(join(packageDir, file), readFileSync(join(rootDir, file)));
  writeFileSync(join(packageDir, 'THIRD_PARTY_NOTICES'), `${name}\nNo bundled dependencies.\n`);
  const filename = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
  const tarball = join(directory, filename);
  execFileSync('tar', ['-czf', tarball, '-C', directory, 'package']);
  const git = (args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim();
  const manifest = {
    schemaVersion: 2, sourceCommit: git(['rev-parse', 'HEAD']), sourceTree: git(['rev-parse', 'HEAD^{tree}']), sourceDirty: true,
    packages: [{ name, version, filename, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') }],
  };
  const manifestFile = join(directory, 'release-manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const bin = join(directory, 'bin'); mkdirSync(bin);
  const log = join(directory, 'npm-calls.jsonl');
  const missingRegistry = join(directory, 'missing-registry.mjs');
  writeFileSync(missingRegistry, 'globalThis.fetch = async () => new Response("{}", { status: 404 });\n');
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.ZUCKER_NPM_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n', { mode: 0o755 });
  const run = (args = [], environment = {}) => spawnSync(process.execPath, [script, '--bundle', directory, '--allow-dirty', ...args], {
    cwd: rootDir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZUCKER_NPM_TEST_LOG: log,
      GITHUB_RUN_ID: '', GITHUB_WORKFLOW_REF: '',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(missingRegistry).href}`.trim(), ...environment },
  });
  return { directory, manifest, manifestFile, log, run };
}

function cleanFixture() {
  const f = fixture();
  f.manifest.sourceDirty = false;
  writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
  const approvedHash = createHash('sha256').update(readFileSync(f.manifestFile)).digest('hex');
  writeFileSync(join(f.directory, 'release-receipt.json'), JSON.stringify(releaseReceipt(f.manifest.sourceCommit, approvedHash)));
  const github = githubFixture(f.directory, f.manifest.sourceCommit);
  const bin = join(f.directory, 'bin');
  // Only this subprocess sees the synthetic clean checkout and registry. No
  // repository state or real registry is changed when exercising upload mode.
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'status') process.exit(0);
const values = ${JSON.stringify({ HEAD: f.manifest.sourceCommit, 'HEAD^{tree}': f.manifest.sourceTree })};
if (args[0] !== 'rev-parse' || !values[args[1]]) throw new Error('Unexpected git command');
console.log(values[args[1]]);
`, { mode: 0o755 });
  const digest = createHash('sha1').update(readFileSync(join(f.directory, f.manifest.packages[0].filename))).digest('hex');
  const auth = join(f.directory, 'auth.json');
  const published = join(f.directory, 'published');
  const networkLog = join(f.directory, 'registry-requests.jsonl');
  const preload = join(f.directory, 'registry-fetch.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
// Fake only this fixture subprocess's propagation clock; production waits stay bounded.
timers.setTimeout = async () => {};
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  if (parsed.hostname !== 'registry.npmjs.org' || !parsed.searchParams.has('release_check')) throw new Error('Unexpected registry request');
  fs.appendFileSync(${JSON.stringify(networkLog)}, String(url) + '\\n');
  if (!fs.existsSync(${JSON.stringify(published)})) {
    if (process.env.ZUCKER_TEST_PACKAGE_EXISTS === '1' && decodeURIComponent(parsed.pathname) === '/@zucker-framework/publish-fixture')
      return new Response(JSON.stringify({ name: '@zucker-framework/publish-fixture', versions: {} }));
    return new Response('{}', { status: 404 });
  }
  if (parsed.pathname.endsWith('/dist-tags')) return new Response(JSON.stringify({ latest: process.env.ZUCKER_TEST_TAG_VERSION || '1.0.0' }));
  return new Response(JSON.stringify({ name: '@zucker-framework/publish-fixture', version: '1.0.0', dist: { shasum: process.env.ZUCKER_TEST_DIGEST || ${JSON.stringify(digest)} },
    'dist-tags': { latest: process.env.ZUCKER_TEST_TAG_VERSION || '1.0.0' } }));
};\n`);
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ZUCKER_NPM_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'whoami' || args[0] === '--version') {
  const config = process.env.NPM_CONFIG_USERCONFIG;
  fs.writeFileSync(${JSON.stringify(auth)}, JSON.stringify({ config, contents: fs.readFileSync(config, 'utf8'), hasNodeAuthToken: Boolean(process.env.NODE_AUTH_TOKEN) }));
  console.log(args[0] === '--version' ? '11.19.1' : 'jetlinks');
} else if (args[0] === 'publish') {
  fs.writeFileSync(${JSON.stringify(published)}, 'synthetic registry state');
} else throw new Error('Unexpected npm command');
`, { mode: 0o755 });
  return { ...f, auth, github, approvedHash, networkLog, rawRun: f.run,
    run: (args = [], environment = {}) => f.run([...args, '--manifest-sha256', approvedHash], {
      ...environment, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim(),
    }) };
}

test('default release command performs only npm dry runs with public access', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'publish');
    assert(calls[0].includes('--dry-run'));
    assert.equal(calls[0][calls[0].indexOf('--access') + 1], 'public');
    assert.equal(calls[0][calls[0].indexOf('--tag') + 1], 'latest');
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('explicit upload still refuses dirty review bundles before calling npm', () => {
  const f = fixture();
  try {
    const result = f.run(['--publish']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dirty worktree/);
    assert.equal(existsSync(f.log), false);
    assert.match(f.run(['--publish', '--dry-run']).stderr, /Choose --publish or --dry-run/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('rejects packages outside the maintained npm organization before calling npm', () => {
  const f = fixture('@unowned/publish-fixture');
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid package identity or archive filename/);
    assert.equal(existsSync(f.log), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('requires a separate distribution tag for prerelease packages', () => {
  const f = fixture('@zucker-framework/publish-fixture', '1.1.0-rc.0');
  try {
    assert.match(f.run().stderr, /Prerelease packages cannot use the latest tag/);
    assert.equal(existsSync(f.log), false);
    assert.equal(f.run(['--tag', 'rc']).status, 0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

for (const mode of ['local login', 'CI token']) {
  test(`checks authentication and registry checksums using ${mode}`, () => {
    const f = cleanFixture();
    try {
      const config = join(f.directory, 'user.npmrc');
      writeFileSync(config, 'registry=https://registry.npmjs.org/\n');
      const result = f.run(['--publish'], {
        NPM_CONFIG_USERCONFIG: config,
        NODE_AUTH_TOKEN: mode === 'CI token' ? 'synthetic-test-token' : '',
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(calls.map((args) => args[0]), ['whoami', 'publish']);
      assert.equal(readFileSync(f.networkLog, 'utf8').trim().split('\n').length, 4);
      assert(!calls[1].includes('--dry-run'));
      const auth = JSON.parse(readFileSync(f.auth, 'utf8'));
      if (mode === 'local login') {
        assert.equal(auth.config, config);
        assert.equal(auth.contents, 'registry=https://registry.npmjs.org/\n');
      } else {
        assert.notEqual(auth.config, config);
        assert(auth.contents.includes('@zucker-framework:registry='));
        assert(auth.contents.includes('_authToken=${NODE_AUTH_TOKEN}'));
        assert(!auth.contents.includes('synthetic-test-token'));
      }
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });
}

test('OIDC publishing skips whoami and removes token fallback credentials', () => {
  const f = cleanFixture();
  try {
    const result = f.run(['--publish', '--auth', 'oidc'], {
      GITHUB_ACTIONS: 'true', GITHUB_SHA: f.manifest.sourceCommit,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/fixture',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request', NODE_AUTH_TOKEN: 'must-not-be-used',
      ZUCKER_TEST_PACKAGE_EXISTS: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(args => args[0]), ['--version', 'publish']);
    const auth = JSON.parse(readFileSync(f.auth, 'utf8'));
    assert.equal(auth.hasNodeAuthToken, false);
    assert(!auth.contents.includes('_authToken'));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('fails before npm for unapproved bytes, failed CI or unavailable OIDC identity', () => {
  const f = cleanFixture();
  try {
    assert.match(f.rawRun(['--publish']).stderr, /approved --manifest-sha256/);
    assert.match(f.run(['--publish', '--manifest-sha256', '0'.repeat(64)]).stderr, /approved --manifest-sha256/);
    assert.match(f.run(['--publish', '--auth', 'oidc'], { GITHUB_ACTIONS: '', ACTIONS_ID_TOKEN_REQUEST_URL: '' }).stderr, /OIDC publishing requires/);
    f.github.data.jobs.at(-1).conclusion = 'failure'; f.github.save();
    assert.match(f.run(['--publish']).stderr, /Required CI job/);
    assert.equal(existsSync(f.log), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('resumes identical published versions and verifies the final tag for the whole batch', () => {
  const f = cleanFixture();
  try {
    const config = join(f.directory, 'user.npmrc');
    writeFileSync(config, 'registry=https://registry.npmjs.org/\n');
    const environment = { NPM_CONFIG_USERCONFIG: config, NODE_AUTH_TOKEN: '' };
    assert.equal(f.run(['--publish', '--auth', 'session'], environment).status, 0);
    const result = f.run(['--publish', '--auth', 'session'], environment);
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(args => args[0] === 'publish').length, 1);
    assert(existsSync(join(f.directory, 'registry-verification.json')));
    assert.equal(f.run(['--dry-run'], environment).status, 0);
    const afterDryRun = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(afterDryRun.filter(args => args[0] === 'publish').length, 1);
    assert.match(f.run(['--publish', '--auth', 'session'], { ...environment, ZUCKER_TEST_TAG_VERSION: '0.9.0' }).stderr, /did not expose @zucker-framework\/publish-fixture@latest=1.0.0/);
    assert.match(f.run(['--publish', '--auth', 'session'], { ...environment, ZUCKER_TEST_DIGEST: 'b'.repeat(40) }).stderr, /Immutable version conflict/);
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse).filter(args => args[0] === 'publish').length, 1);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('submits the whole batch before checking delayed post-upload metadata', () => {
  const f = cleanFixture();
  try {
    const name = '@zucker-framework/second-fixture';
    const packageDir = join(f.directory, 'package');
    const packed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    packed.name = name;
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packed));
    writeFileSync(join(packageDir, 'THIRD_PARTY_NOTICES'), `${name}\nNo bundled dependencies.\n`);
    const filename = 'zucker-framework-second-fixture-1.0.0.tgz';
    execFileSync('tar', ['-czf', join(f.directory, filename), '-C', f.directory, 'package']);
    f.manifest.packages.push({ name, version: '1.0.0', filename,
      sha256: createHash('sha256').update(readFileSync(join(f.directory, filename))).digest('hex') });
    writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
    const approvedHash = createHash('sha256').update(readFileSync(f.manifestFile)).digest('hex');
    writeFileSync(join(f.directory, 'release-receipt.json'), JSON.stringify(releaseReceipt(f.manifest.sourceCommit, approvedHash)));
    const entries = f.manifest.packages.map(p => ({ ...p, tarball: join(f.directory, p.filename),
      shasum: createHash('sha1').update(readFileSync(join(f.directory, p.filename))).digest('hex') }));
    const state = join(f.directory, 'batch-uploads.json');
    writeFileSync(state, '[]');
    writeFileSync(join(f.directory, 'bin/npm'), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2), entries = ${JSON.stringify(entries)};
fs.appendFileSync(process.env.ZUCKER_NPM_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') console.log('11.19.1');
else if (args[0] === 'publish') {
  const entry = entries.find(p => p.tarball === args[1]);
  if (!entry) throw new Error('Unexpected archive');
  const uploaded = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
  uploaded.push(entry.name); fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(uploaded));
} else throw new Error('Unexpected npm command');
`, { mode: 0o755 });
    const preload = join(f.directory, 'batch-registry.mjs');
    writeFileSync(preload, `import fs from 'node:fs';
const entries = ${JSON.stringify(entries)};
globalThis.fetch = async url => {
  const uploaded = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
  if (!uploaded.length) {
    const existing = entries.find(p => decodeURIComponent(new URL(url).pathname) === '/' + p.name);
    return existing ? new Response(JSON.stringify({ name: existing.name, versions: {} }))
      : new Response('{}', { status: 404 });
  }
  // Fail immediately if the publisher stalls on a read between the two uploads.
  if (uploaded.length !== entries.length) return new Response('{}', { status: 403 });
  const pathname = decodeURIComponent(new URL(url).pathname);
  const entry = entries.find(p => pathname.includes(p.name));
  if (!entry) throw new Error('Unexpected registry request');
  const data = pathname.endsWith('/dist-tags') ? { latest: entry.version }
    : { name: entry.name, version: entry.version, dist: { shasum: entry.shasum } };
  return new Response(JSON.stringify(data));
};\n`);
    const result = f.rawRun(['--publish', '--auth', 'oidc', '--manifest-sha256', approvedHash], {
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      GITHUB_ACTIONS: 'true', GITHUB_SHA: f.manifest.sourceCommit,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/fixture',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), entries.map(p => p.name));
    const verified = JSON.parse(readFileSync(join(f.directory, 'registry-verification.json'), 'utf8'));
    assert.equal(verified.packages.length, 2);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('rejects archive traversal, modified checksums and mismatched registry settings before npm', () => {
  const f = fixture();
  try {
    const original = structuredClone(f.manifest);
    f.manifest.packages[0].filename = '../outside.tgz';
    writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
    assert.match(f.run().stderr, /Invalid package identity or archive filename/);
    original.packages[0].sha256 = '0'.repeat(64);
    writeFileSync(f.manifestFile, JSON.stringify(original));
    assert.match(f.run().stderr, /Checksum mismatch/);
    assert.match(f.run(['--registry', 'https://user:secret@registry.example.com']).stderr, /must not contain credentials/);
    assert.equal(existsSync(f.log), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

function mixedPackageFixture() {
  const f = cleanFixture();
  const name = '@zucker-framework/new-fixture', version = '1.0.0';
  const packageDir = join(f.directory, 'package');
  const packed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ ...packed, name }));
  writeFileSync(join(packageDir, 'THIRD_PARTY_NOTICES'), `${name}\nNo bundled dependencies.\n`);
  const filename = 'zucker-framework-new-fixture-1.0.0.tgz';
  execFileSync('tar', ['-czf', join(f.directory, filename), '-C', f.directory, 'package']);
  f.manifest.packages.push({ name, version, filename,
    sha256: createHash('sha256').update(readFileSync(join(f.directory, filename))).digest('hex') });
  writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
  const hash = createHash('sha256').update(readFileSync(f.manifestFile)).digest('hex');
  writeFileSync(join(f.directory, 'release-receipt.json'), JSON.stringify(releaseReceipt(f.manifest.sourceCommit, hash)));
  const entries = f.manifest.packages.map(p => ({ ...p, tarball: join(f.directory, p.filename),
    shasum: createHash('sha1').update(readFileSync(join(f.directory, p.filename))).digest('hex') }));
  const state = join(f.directory, 'uploaded.json');
  writeFileSync(state, '[]');
  const config = join(f.directory, 'user.npmrc');
  writeFileSync(config, 'registry=https://registry.npmjs.org/\n');
  writeFileSync(join(f.directory, 'bin/npm'), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2), entries = ${JSON.stringify(entries)};
fs.appendFileSync(process.env.ZUCKER_NPM_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') console.log('11.19.1');
else if (args[0] === 'whoami') console.log('jetlinks');
else if (args[0] === 'publish') {
  const entry = entries.find(p => p.tarball === args[1]);
  if (!entry) throw new Error('Unexpected archive');
  if (!args.includes('--dry-run')) {
    const uploaded = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
    if (uploaded.includes(entry.name)) throw new Error('Unexpected repeated upload');
    uploaded.push(entry.name); fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(uploaded));
  }
} else throw new Error('Unexpected npm command');
`, { mode: 0o755 });
  const preload = join(f.directory, 'mixed-registry.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
const entries = ${JSON.stringify(entries)};
globalThis.fetch = async url => {
  const parsed = new URL(url), pathname = decodeURIComponent(parsed.pathname);
  if (parsed.hostname !== 'registry.npmjs.org' || !parsed.searchParams.has('release_check')) throw new Error('Unexpected registry request');
  const entry = entries.find(p => pathname.includes(p.name));
  if (!entry) throw new Error('Unexpected package');
  const uploaded = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
  const published = uploaded.includes(entry.name);
  const metadata = { name: entry.name, version: entry.version, dist: { shasum: entry.shasum } };
  if (pathname === '/' + entry.name) {
    if (entry.name === ${JSON.stringify(name)} && process.env.ZUCKER_TEST_INDEX_DENIED === '1') return new Response('{}', { status: 403 });
    return published || entry.name === entries[0].name
      ? new Response(JSON.stringify({ name: entry.name, versions: published ? { [entry.version]: metadata } : {} }))
      : new Response('{}', { status: 404 });
  }
  if (!published) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify(pathname.endsWith('/dist-tags') ? { latest: entry.version } : metadata));
};\n`);
  return { ...f, newName: name, entries, state,
    run: (args, environment = {}) => f.rawRun([...args, '--manifest-sha256', hash], {
      NPM_CONFIG_USERCONFIG: config, NODE_AUTH_TOKEN: '', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      GITHUB_ACTIONS: 'true', GITHUB_SHA: f.manifest.sourceCommit,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/fixture',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request', ...environment,
    }),
  };
}

test('dry-run reports only unregistered names and never uploads or changes the manifest', () => {
  const f = mixedPackageFixture();
  try {
    const report = join(f.directory, 'new-packages.json'), before = readFileSync(f.manifestFile);
    const result = f.run(['--dry-run', '--new-packages-report', report]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(report)), { schemaVersion: 1, newPackages: [f.newName] });
    assert.deepEqual(JSON.parse(readFileSync(f.state)), []);
    assert.deepEqual(readFileSync(f.manifestFile), before);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
    assert(calls.every(args => args.includes('--dry-run')));
    assert.match(f.run(['--dry-run', '--new-packages-report', f.manifestFile]).stderr, /Refusing to overwrite/);
    assert.deepEqual(readFileSync(f.manifestFile), before);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('OIDC refuses every upload when the batch includes an unregistered package', () => {
  const f = mixedPackageFixture();
  try {
    const result = f.run(['--publish', '--auth', 'oidc']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Maintainer bootstrap required.*@zucker-framework\/new-fixture/);
    assert.deepEqual(JSON.parse(readFileSync(f.state)), []);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(args => args[0] === 'publish').length, 0);
    assert.equal(existsSync(join(f.directory, 'registry-verification.json')), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('session bootstrap uploads only new names, remains idempotent, and ordinary OIDC completes the same bundle', () => {
  const f = mixedPackageFixture();
  try {
    const before = readFileSync(f.manifestFile);
    const bootstrap = () => f.run(['--publish', '--auth', 'session', '--bootstrap-new']);
    const first = bootstrap();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.state)), [f.newName]);
    const report = JSON.parse(readFileSync(join(f.directory, 'bootstrap-verification.json')));
    assert.equal(report.fullReleaseComplete, false);
    assert.equal(report.mode, 'bootstrap-new');
    assert.deepEqual(report.packages.map(p => p.name), [f.newName]);
    assert.equal(existsSync(join(f.directory, 'registry-verification.json')), false);
    const second = bootstrap();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.state)), [f.newName]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'bootstrap-verification.json'))).packages, []);
    const release = f.run(['--publish', '--auth', 'oidc']);
    assert.equal(release.status, 0, release.stderr);
    assert.deepEqual(new Set(JSON.parse(readFileSync(f.state))), new Set(f.entries.map(p => p.name)));
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'registry-verification.json'))).packages.length, 2);
    assert.deepEqual(readFileSync(f.manifestFile), before);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('bootstrap requires explicit session upload and retains source, CI and full-bundle checksum checks', () => {
  const dirty = fixture();
  try {
    for (const args of [[], ['--publish'], ['--publish', '--auth', 'oidc'], ['--publish', '--auth', 'token']]) {
      assert.match(dirty.run([...args, '--bootstrap-new']).stderr, /requires --publish --auth session/);
    }
    assert.match(dirty.run(['--publish', '--auth', 'session', '--bootstrap-new']).stderr, /dirty worktree/);
    assert.equal(existsSync(dirty.log), false);
  } finally { rmSync(dirty.directory, { recursive: true, force: true }); }
  const f = mixedPackageFixture();
  try {
    f.github.data.jobs.at(-1).conclusion = 'failure'; f.github.save();
    assert.match(f.run(['--publish', '--auth', 'session', '--bootstrap-new']).stderr, /Required CI job/);
    f.github.data.jobs.at(-1).conclusion = 'success'; f.github.save();
    writeFileSync(join(f.directory, f.entries[0].filename), 'changed non-bootstrap archive');
    assert.match(f.run(['--publish', '--auth', 'session', '--bootstrap-new']).stderr, /Checksum mismatch/);
    assert.equal(existsSync(f.log), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('unavailable registry indexes do not become a bootstrap report or an upload', () => {
  const f = mixedPackageFixture();
  try {
    const report = join(f.directory, 'new-packages.json');
    const result = f.run(['--dry-run', '--new-packages-report', report], { ZUCKER_TEST_INDEX_DENIED: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed \(403\)/);
    assert.equal(existsSync(report), false);
    assert.equal(existsSync(f.log), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
