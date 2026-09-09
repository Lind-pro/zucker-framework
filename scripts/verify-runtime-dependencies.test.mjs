import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStaticRuntimeDependencies } from './verify-runtime-dependencies.mjs';

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
