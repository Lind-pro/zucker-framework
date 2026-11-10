import assert from 'node:assert/strict';
import { test } from 'node:test';

const { pollDelay, pollUntilDone, isTerminalStatus, sleep } = await import('./polling.ts');

test('terminal statuses are exactly COMPLETED, FAILED, CANCELLED', () => {
  for (const s of ['COMPLETED', 'FAILED', 'CANCELLED']) assert.equal(isTerminalStatus(s), true, s);
  for (const s of ['QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING', 'completed', '', 'UNKNOWN']) assert.equal(isTerminalStatus(s), false, s);
});

test('pollDelay never exceeds maxMs even with a huge attempt or factor, and honours custom options', () => {
  assert.equal(pollDelay(10_000, {}, () => 1), 15_000);
  assert.equal(pollDelay(5, { factor: 1000, maxMs: 9000 }, () => 0.5), 9000);
  assert.equal(pollDelay(0, { initialMs: 100, maxMs: 50 }, () => 0.5), 100);
  assert.equal(pollDelay(3, { factor: 0.1, initialMs: 200 }, () => 0.5), 200);
  assert.equal(pollDelay(Infinity, {}, () => 0.5), 1500);
});

test('already-terminal first value: one load, no waiting, onUpdate called once', async () => {
  const waits = [], updates = [];
  const value = await pollUntilDone({ load: async () => ({ status: 'FAILED' }), isDone: (v) => isTerminalStatus(v.status), onUpdate: (v) => updates.push(v), wait: async (ms) => void waits.push(ms) });
  assert.equal(value.status, 'FAILED');
  assert.deepEqual(waits, []);
  assert.equal(updates.length, 1);
});

test('404 (fatal) stops immediately even in the middle of polling; non-fatal errors reset the counter on success', async () => {
  let calls = 0;
  const seq = [{ status: 'QUEUED' }, 'err', 'err', { status: 'QUEUED' }, 'err', 'err', { status: 'COMPLETED' }];
  const done = await pollUntilDone({
    load: async () => { const item = seq[calls++]; if (item === 'err') throw new Error('blip'); return item; },
    isDone: (v) => isTerminalStatus(v.status), maxConsecutiveErrors: 3, wait: async () => {},
  });
  assert.equal(done.status, 'COMPLETED');
  assert.equal(calls, 7);

  let n = 0;
  await assert.rejects(
    pollUntilDone({ load: async () => { n++; if (n === 1) return { status: 'QUEUED' }; throw Object.assign(new Error('gone'), { status: 404 }); }, isDone: () => false, isFatal: (e) => e.status === 404, wait: async () => {} }),
    /gone/,
  );
  assert.equal(n, 2);
});

test('abort during an in-flight load rejects with the abort reason and does not call onUpdate', async () => {
  const controller = new AbortController();
  const updates = [];
  const run = pollUntilDone({
    load: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'QUEUED' }), 30)),
    isDone: () => false, onUpdate: (v) => updates.push(v), signal: controller.signal, wait: async () => {},
  });
  setTimeout(() => controller.abort(new Error('unmounted')), 5);
  await assert.rejects(run, /unmounted/);
  assert.deepEqual(updates, []);
});

test('abort while waiting rejects without another load; sleep clears its timer and listener', async () => {
  const controller = new AbortController();
  let loads = 0;
  const run = pollUntilDone({ load: async () => (loads++, { status: 'QUEUED' }), isDone: () => false, signal: controller.signal, backoff: { initialMs: 10_000, maxMs: 10_000 } });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(run);
  assert.equal(loads, 1);
  const start = Date.now();
  await sleep(15);
  assert.ok(Date.now() - start >= 10);
  const c2 = new AbortController();
  const p = sleep(60_000, c2.signal);
  c2.abort(new Error('x'));
  await assert.rejects(p, /x/);
});

test('an aborted signal wins over fatal/transient errors thrown by load', async () => {
  const controller = new AbortController();
  await assert.rejects(
    pollUntilDone({ load: async () => { controller.abort(new Error('left')); throw new Error('network'); }, isDone: () => false, signal: controller.signal, wait: async () => {} }),
    /left/,
  );
});
