import assert from 'node:assert/strict';
import test from 'node:test';
import { orderReleasePackages } from './release-graph.mjs';

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
