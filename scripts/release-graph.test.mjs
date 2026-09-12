import assert from 'node:assert/strict';
import test from 'node:test';
import { orderReleasePackages, selectReleasePackages } from './release-graph.mjs';

test('selects only requested upload artifacts while retaining their original identities', () => {
  const packages = [
    { name: '@zucker-framework/core', version: '1.0.2', sha256: 'core-bytes' },
    { name: '@zucker-framework/logging', version: '1.0.3', sha256: 'logging-bytes' },
    { name: '@zucker-framework/media', version: '1.0.3', sha256: 'media-bytes' },
  ];
  assert.equal(selectReleasePackages(packages), packages);
  const selected = selectReleasePackages(packages, '@zucker-framework/media,@zucker-framework/logging');
  assert.deepEqual(selected, [packages[1], packages[2]]);
  assert.equal(selected[0], packages[1]);
  assert.equal(packages.length, 3);
});

test('rejects misspelled, empty and duplicate release selections', () => {
  const packages = [{ name: 'media' }];
  assert.throws(() => selectReleasePackages(packages, 'missing'), /Unknown release package/);
  for (const selection of ['', 'media,', 'media,media']) {
    assert.throws(() => selectReleasePackages(packages, selection), /unique, nonempty/);
  }
});

test('orders dependencies, optional dependencies and peers before their consumers', () => {
  const packages = [
    { name: 'admin', dependencies: { auth: '1.0.0' }, optionalDependencies: { mail: '1.0.0' } },
    { name: 'auth', peerDependencies: { core: '^1.0.0' } },
    { name: 'mail', dependencies: { core: '1.0.0', external: '^1' } },
    { name: 'core' },
  ];
  const order = orderReleasePackages(packages).map(({ name }) => name);
  assert.deepEqual(order, ['core', 'auth', 'mail', 'admin']);
  assert.deepEqual(orderReleasePackages([...packages].reverse()).map(({ name }) => name), order);
});

test('waits for CLI scaffold targets without adding them as installed runtime dependencies', () => {
  const cli = { name: 'cli', releaseDependencies: ['task', 'core'] };
  assert.deepEqual(orderReleasePackages([cli, { name: 'task', dependencies: { core: '1' } }, { name: 'core' }]).map(p => p.name), ['core', 'task', 'cli']);
  assert.equal(cli.dependencies, undefined);
});

test('rejects cycles and multiple versions of the same package in one release', () => {
  assert.throws(() => orderReleasePackages([{ name: 'a', dependencies: { b: '1' } }, { name: 'b', dependencies: { a: '1' } }]), /a -> b -> a/);
  assert.throws(() => orderReleasePackages([{ name: 'a', version: '1' }, { name: 'a', version: '2' }]), /Duplicate package/);
});
