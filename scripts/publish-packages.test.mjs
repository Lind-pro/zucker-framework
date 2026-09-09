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
globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  if (parsed.hostname !== 'registry.npmjs.org' || !parsed.searchParams.has('release_check')) throw new Error('Unexpected registry request');
  fs.appendFileSync(${JSON.stringify(networkLog)}, String(url) + '\\n');
  if (!fs.existsSync(${JSON.stringify(published)})) return new Response('{}', { status: 404 });
  if (parsed.pathname.endsWith('/dist-tags')) return new Response(JSON.stringify({ latest: process.env.ZUCKER_TEST_TAG_VERSION || '1.0.0' }));
  return new Response(JSON.stringify({ name: '@zucker-framework/publish-fixture', version: '1.0.0', dist: { shasum: ${JSON.stringify(digest)} },
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
      assert.equal(readFileSync(f.networkLog, 'utf8').trim().split('\n').length, 3);
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
    f.github.data.jobs[1].conclusion = 'failure'; f.github.save();
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
    assert.match(f.run(['--publish', '--auth', 'session'], { ...environment, ZUCKER_TEST_TAG_VERSION: '0.9.0' }).stderr, /Registry tag verification failed/);
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
