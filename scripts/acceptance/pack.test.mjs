import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pack, publishablePackages, rootDir, tarballDigests } from './pack.mjs';
import { loadManifest } from './file-registry.mjs';

const VERSION = '3.4.5';
const script = fileURLToPath(new URL('./pack.mjs', import.meta.url));

/** A throwaway workspace: no git, no network, no build (pack is always called with skipBuild). */
function fixtureRoot(packages) {
  const root = mkdtempSync(join(tmpdir(), 'zf-pack-test-'));
  for (const [dir, manifest] of Object.entries(packages)) {
    const directory = join(root, 'packages', dir);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ files: ['index.js'], ...manifest }));
    writeFileSync(join(directory, 'index.js'), 'module.exports = {};\n');
  }
  return root;
}
const silent = () => {};

test('packs one tarball per non-private package with the fixed version and writes a matching manifest', () => {
  const root = fixtureRoot({
    core: { name: '@zucker-framework/core', version: VERSION, dependencies: { '@zucker-framework/crud': VERSION } },
    crud: { name: '@zucker-framework/crud', version: VERSION },
    'template-only': { name: '@zucker-framework/template-only', version: VERSION, private: true },
  });
  const out = mkdtempSync(join(tmpdir(), 'zf-pack-out-'));
  try {
    const manifest = pack({ out, skipBuild: true, root, log: silent });
    assert.equal(manifest.release, false);
    assert.deepEqual(manifest.packages.map((p) => p.name), ['@zucker-framework/core', '@zucker-framework/crud']);
    assert.ok(manifest.packages.every((p) => p.version === VERSION), 'every package carries the fixed version');
    assert.deepEqual(readdirSync(join(out, 'tarballs')).sort(), [`zucker-framework-core-${VERSION}.tgz`, `zucker-framework-crud-${VERSION}.tgz`]);
    for (const entry of manifest.packages) {
      const digests = tarballDigests(join(out, 'tarballs', entry.file));
      assert.equal(entry.integrity, digests.integrity);
      assert.equal(entry.shasum, digests.shasum);
      assert.equal(entry.packageJson.version, VERSION);
    }
    // The file registry accepts exactly what pack wrote.
    assert.deepEqual([...loadManifest(join(out, 'manifest.json')).keys()], ['@zucker-framework/core', '@zucker-framework/crud']);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).packages.map((p) => p.file), manifest.packages.map((p) => p.file));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('refuses a package whose tarball still carries a workspace/link/file dependency', () => {
  const root = fixtureRoot({ core: { name: '@zucker-framework/core', version: VERSION, dependencies: { local: 'file:../local' } } });
  const out = mkdtempSync(join(tmpdir(), 'zf-pack-out-'));
  try {
    assert.throws(() => pack({ out, skipBuild: true, root, log: silent }), /packs a local reference for local: file:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('refuses to reuse a non-empty tarballs directory', () => {
  const root = fixtureRoot({ core: { name: '@zucker-framework/core', version: VERSION } });
  const out = mkdtempSync(join(tmpdir(), 'zf-pack-out-'));
  try {
    mkdirSync(join(out, 'tarballs'));
    writeFileSync(join(out, 'tarballs', 'stale.tgz'), 'x');
    assert.throws(() => pack({ out, skipBuild: true, root, log: silent }), /Refusing to reuse/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('publishablePackages skips private packages and sorts by name', () => {
  const root = fixtureRoot({
    b: { name: '@zucker-framework/zeta', version: VERSION },
    a: { name: '@zucker-framework/alpha', version: VERSION },
    c: { name: '@zucker-framework/hidden', version: VERSION, private: true },
  });
  try {
    assert.deepEqual(publishablePackages(root).map((p) => p.manifest.name), ['@zucker-framework/alpha', '@zucker-framework/zeta']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real workspace publishes only @zucker-framework packages, all at one fixed version', () => {
  const packages = publishablePackages(rootDir);
  assert.ok(packages.length > 0);
  assert.ok(packages.every(({ manifest }) => manifest.name.startsWith('@zucker-framework/')));
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  assert.equal(versions.size, 1, `expected one fixed version, found ${[...versions].join(', ')}`);
  assert.ok(packages.every(({ manifest }) => /^\d+\.\d+\.\d+/.test(manifest.version)));
});

test('CLI requires --out', () => {
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }), /usage: pack\.mjs/s);
  try {
    execFileSync(process.execPath, [script], { stdio: 'pipe' });
  } catch (error) {
    assert.notEqual(error.status, 0);
    assert.match(String(error.stderr), /usage: pack\.mjs --out/);
  }
});
