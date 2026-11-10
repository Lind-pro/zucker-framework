import assert from 'node:assert/strict';
import { test } from 'node:test';

const { pollDelay, pollUntilDone, isTerminalStatus, sleep } = await import('./polling.ts');
const { aiFailureKind, isDefiniteRejection, nextSubmitAttempt } = await import('./errors.ts');
const { parseOutputTicket } = await import('./download.ts');

test('pollDelay grows, is capped and stays within jitter bounds', () => {
  const mid = () => 0.5; // zero jitter
  assert.equal(pollDelay(0, {}, mid), 1500);
  assert.equal(pollDelay(1, {}, mid), 2400);
  assert.ok(pollDelay(3, {}, mid) > pollDelay(2, {}, mid));
  assert.equal(pollDelay(50, {}, mid), 15000);
  assert.equal(pollDelay(-3, {}, mid), 1500);
  assert.equal(pollDelay(Number.NaN, {}, mid), 1500);
  assert.equal(pollDelay(10, { maxMs: 4000 }, () => 1), 4000);
  assert.equal(pollDelay(0, { jitter: 1 }, () => 0), 750);
  for (let attempt = 0; attempt < 20; attempt++)
    for (const r of [0, 0.25, 0.99]) {
      const value = pollDelay(attempt, {}, () => r);
      assert.ok(value >= 750 && value <= 15000, `${attempt}/${r} -> ${value}`);
    }
});

test('pollUntilDone stops at a terminal value and resets backoff on activity', async () => {
  const views = [
    { status: 'QUEUED', progress: 0 },
    { status: 'QUEUED', progress: 0 },
    { status: 'WAITING_PROVIDER', progress: 40 },
    { status: 'WAITING_PROVIDER', progress: 40 },
    { status: 'COMPLETED', progress: 100 },
  ];
  const waits = [], updates = [];
  let calls = 0;
  const result = await pollUntilDone({
    load: async () => views[calls++],
    isDone: (view) => isTerminalStatus(view.status),
    onUpdate: (view) => updates.push(view.status),
    activityKey: (view) => `${view.status}:${view.progress}`,
    wait: async (ms) => void waits.push(ms),
    random: () => 0.5,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(calls, 5);
  assert.deepEqual(updates, ['QUEUED', 'QUEUED', 'WAITING_PROVIDER', 'WAITING_PROVIDER', 'COMPLETED']);
  // attempt 0, 1, then reset to 0 after the status change, then 1.
  assert.deepEqual(waits, [1500, 2400, 1500, 2400]);
});

test('pollUntilDone tolerates transient errors, throws after the limit, and fails fast on fatal ones', async () => {
  let calls = 0;
  const flaky = await pollUntilDone({
    load: async () => {
      calls += 1;
      if (calls < 3) throw new Error('network');
      return { status: 'FAILED' };
    },
    isDone: (view) => isTerminalStatus(view.status),
    wait: async () => {},
  });
  assert.equal(flaky.status, 'FAILED');

  let attempts = 0;
  await assert.rejects(
    pollUntilDone({ load: async () => { attempts += 1; throw new Error('down'); }, isDone: () => false, maxConsecutiveErrors: 3, wait: async () => {} }),
    /down/,
  );
  assert.equal(attempts, 3);

  let fatalCalls = 0;
  const missing = Object.assign(new Error('gone'), { status: 404 });
  await assert.rejects(
    pollUntilDone({ load: async () => { fatalCalls += 1; throw missing; }, isDone: () => false, isFatal: (e) => e.status === 404, wait: async () => {} }),
    /gone/,
  );
  assert.equal(fatalCalls, 1);
});

test('pollUntilDone and sleep honour abort', async () => {
  const controller = new AbortController();
  let calls = 0;
  const run = pollUntilDone({
    load: async () => {
      calls += 1;
      return { status: 'PROCESSING' };
    },
    isDone: () => false,
    signal: controller.signal,
    backoff: { initialMs: 20, maxMs: 20 },
  });
  setTimeout(() => controller.abort(new Error('left page')), 5);
  await assert.rejects(run, /left page/);
  assert.equal(calls, 1);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(sleep(10, pre.signal));
  let loaded = false;
  await assert.rejects(pollUntilDone({ load: async () => { loaded = true; return {}; }, isDone: () => true, signal: pre.signal }));
  assert.equal(loaded, false);
});

test('delayFirst waits before the first load', async () => {
  const order = [];
  await pollUntilDone({
    load: async () => (order.push('load'), { status: 'COMPLETED' }),
    isDone: () => true,
    delayFirst: true,
    wait: async () => void order.push('wait'),
  });
  assert.deepEqual(order, ['wait', 'load']);
});

test('failure mapping and idempotency key reuse', () => {
  assert.equal(aiFailureKind({ status: 402, code: 'AI_TASK_INSUFFICIENT_CREDITS' }), 'credits');
  assert.equal(aiFailureKind({ status: 402 }), 'credits');
  assert.equal(aiFailureKind({ status: 409, code: 'AI_TASK_COST_CHANGED' }), 'costChanged');
  assert.equal(aiFailureKind({ status: 409, response: { data: { code: 'AI_CHAT_BUSY' } } }), 'busy');
  assert.equal(aiFailureKind({ status: 400, code: 'ERR_BAD_REQUEST' }), 'invalid');
  assert.equal(aiFailureKind({ status: 503 }), 'unavailable');
  assert.equal(aiFailureKind({ _httpStatus: 502 }), 'providerFailed');
  assert.equal(aiFailureKind(new Error('offline')), 'uncertain');
  assert.equal(isDefiniteRejection({ status: 400 }), true);
  assert.equal(isDefiniteRejection({ status: 503 }), false);
  assert.equal(isDefiniteRejection(new Error('offline')), false);

  let n = 0;
  const create = () => `key-${++n}`;
  const first = nextSubmitAttempt(null, 'a', create);
  assert.equal(first.key, 'key-1');
  assert.equal(nextSubmitAttempt(first, 'a', create), first);
  assert.equal(nextSubmitAttempt(first, 'b', create).key, 'key-2');
  assert.match(nextSubmitAttempt(null, 'x').key, /^ai-[0-9a-f-]{36}$/);
});

test('output tickets: only same-origin private-file download paths that have not expired', () => {
  const origin = 'https://app.example.invalid', now = Date.parse('2026-11-10T00:00:00Z');
  const expiresAt = '2026-11-10T00:05:00Z';
  assert.deepEqual(parseOutputTicket({ url: '/api/files/0b9f-aa/download?token=t1', expiresAt }, origin, now), {
    path: '/api/files/0b9f-aa/download',
    token: 't1',
  });
  for (const url of [
    'https://cdn.provider.example/out.png?token=t1',
    '//evil.example/api/files/x/download?token=t',
    '/api/files/x/other?token=t',
    '/api/files/x/download',
    'javascript:alert(1)',
  ])
    assert.equal(parseOutputTicket({ url, expiresAt }, origin, now), null, url);
  assert.equal(parseOutputTicket({ url: '/api/files/x/download?token=t', expiresAt: '2026-11-09T23:59:59Z' }, origin, now), null);
});
