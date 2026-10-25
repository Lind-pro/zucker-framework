import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('./src/lib/admin-operation-attempt.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
let moduleId = 0;
const load = () => import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${++moduleId}`);
class TestStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
let original;
beforeEach(() => { original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new TestStorage() }); });
afterEach(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else delete globalThis.sessionStorage; });
test('independent pending forms survive refresh without sharing actor/operation keys or storing form contents', async () => {
  const attempts = await load();
  const body = { owner: 'member-a', amount: 10, reason: 'PRIVATE-REASON' };
  const first = await attempts.adminOperationAttempt('credit-grant', 'actor-a', body);
  const second = await attempts.adminOperationAttempt('credit-grant', 'actor-a', { owner: 'member-b', amount: 20 });
  const refund = await attempts.adminOperationAttempt('refund', 'actor-a', body);
  const otherActor = await attempts.adminOperationAttempt('credit-grant', 'actor-b', body);
  assert.equal(new Set([first.key, second.key, refund.key, otherActor.key]).size, 4); assert.equal(first.existing, false);
  const refreshed = await load(), retried = await refreshed.adminOperationAttempt('credit-grant', 'actor-a', body);
  assert.equal(retried.key, first.key); assert.equal(retried.existing, true);
  refreshed.clearAdminOperationAttempt('credit-grant', 'actor-a', first.key);
  assert.equal((await refreshed.adminOperationAttempt('credit-grant', 'actor-a', { owner: 'member-b', amount: 20 })).key, second.key);
  assert.equal((await refreshed.adminOperationAttempt('refund', 'actor-a', body)).key, refund.key);
  const storage = globalThis.sessionStorage, serialized = Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index))).join('');
  assert.doesNotMatch(serialized, /PRIVATE-REASON|member-a|member-b|amount/);
});
test('blocked storage preserves the nonce in this document and reports that refresh persistence is unavailable', async () => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  const attempts = await load(), body = { target: 'order' };
  const first = await attempts.adminOperationAttempt('refund', 'actor-a', body);
  assert.equal(first.persisted, false); assert.equal((await attempts.adminOperationAttempt('refund', 'actor-a', body)).key, first.key);
});
