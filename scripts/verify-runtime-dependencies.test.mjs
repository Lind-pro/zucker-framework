import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPackageRuntimeDependencies, assertStaticRuntimeDependencies } from './verify-runtime-dependencies.mjs';

test('rejects optional peers imported unconditionally by a public entry', () => {
  const manifest = { name: '@example/crud', peerDependencies: { '@example/event': '^1.0.0' }, peerDependenciesMeta: { '@example/event': { optional: true } } };
  const source = 'import { EVENT_TOKEN } from "@example/event"; export { helper } from "missing/subpath";';
  assert.throws(() => assertStaticRuntimeDependencies(manifest, source, 'index.mjs'), /@example\/event, missing/);
  delete manifest.peerDependenciesMeta;
  manifest.dependencies = { missing: '^1.0.0' };
  assert.doesNotThrow(() => assertStaticRuntimeDependencies(manifest, source, 'index.mjs'));
});

test('allows builtins, relative chunks, self imports and optional dynamic adapters', () => {
  assert.doesNotThrow(() => assertStaticRuntimeDependencies({ name: '@example/core' }, `
    import fs from 'node:fs'; import { Buffer } from 'buffer';
    export { value } from './chunk.mjs'; export { other } from '@example/core/subpath';
    export async function adapter() { return import('optional-sdk'); }
  `, 'index.mjs'));
});

const optionalSubpath = {
  name: '@example/ai',
  module: 'dist/index.mjs',
  exports: {
    '.': { import: { types: './dist/index.d.mts', default: './dist/index.mjs' } },
    './adapter': { import: { types: './dist/adapter.d.mts', default: './dist/adapter.mjs' } },
  },
  peerDependencies: { sdk: '^1.0.0' },
  peerDependenciesMeta: { sdk: { optional: true } },
};

test('permits a declared optional peer only in an explicit opt-in subpath and its chunks', () => {
  const sources = new Map([
    ['package/dist/index.mjs', 'export const value = 1;'],
    ['package/dist/adapter.mjs', 'export { adapter } from "./adapter-chunk.mjs";'],
    ['package/dist/adapter-chunk.mjs', 'import sdk from "sdk/client"; export const adapter = sdk;'],
  ]);
  assert.doesNotThrow(() => assertPackageRuntimeDependencies(optionalSubpath, sources));
  sources.set('package/dist/adapter-chunk.mjs', 'import value from "undeclared";');
  assert.throws(() => assertPackageRuntimeDependencies(optionalSubpath, sources), /undeclared/);
});

test('rejects optional peers when the root imports a shared chunk or re-exports the subpath', () => {
  const sources = new Map([
    ['dist/index.mjs', 'export * from "./shared.mjs";'],
    ['dist/adapter.mjs', 'export * from "./shared.mjs";'],
    ['dist/shared.mjs', 'export { value } from "sdk";'],
  ]);
  assert.throws(() => assertPackageRuntimeDependencies(optionalSubpath, sources), /shared\.mjs.*sdk/);
  sources.set('dist/index.mjs', 'export * from "@example/ai/adapter";');
  assert.throws(() => assertPackageRuntimeDependencies(optionalSubpath, sources), /shared\.mjs.*sdk/);
});

test('conditional root exports and executable entries cannot acquire optional dependencies', () => {
  const sources = new Map([['dist/index.mjs', 'import "sdk";']]);
  assert.throws(() => assertPackageRuntimeDependencies({
    ...optionalSubpath, module: undefined, exports: { import: './dist/index.mjs' },
  }, sources), /sdk/);
  assert.throws(() => assertPackageRuntimeDependencies({
    ...optionalSubpath, module: undefined, exports: { './adapter': './dist/index.mjs' },
    bin: { run: './dist/index.mjs' },
  }, sources), /sdk/);
});

test('keeps unexported files strict and handles cycles without losing root reachability', () => {
  const sources = new Map([
    ['dist/index.mjs', 'export * from "./shared.mjs";'],
    ['dist/shared.mjs', 'export * from "./index.mjs";'],
    ['dist/adapter.mjs', 'export const value = 1;'],
    ['dist/unexported.mjs', 'import "sdk";'],
  ]);
  assert.throws(() => assertPackageRuntimeDependencies(optionalSubpath, sources), /unexported\.mjs.*sdk/);
  sources.delete('dist/unexported.mjs');
  assert.doesNotThrow(() => assertPackageRuntimeDependencies(optionalSubpath, sources));
  sources.set('dist/shared.mjs', 'export * from "./index.mjs"; import "sdk";');
  assert.throws(() => assertPackageRuntimeDependencies(optionalSubpath, sources), /shared\.mjs.*sdk/);
});
