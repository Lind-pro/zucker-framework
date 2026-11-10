import assert from 'node:assert/strict';
import { test } from 'node:test';

const { aiFailureKind, failureInfo, isDefiniteRejection, nextSubmitAttempt } = await import('./errors.ts');

test('failureInfo trusts only AI_* server codes and numeric statuses', () => {
  assert.deepEqual(failureInfo(null), { status: undefined, code: undefined });
  assert.deepEqual(failureInfo(undefined), { status: undefined, code: undefined });
  assert.equal(failureInfo({ status: '402' }).status, undefined);
  assert.equal(failureInfo({ _httpStatus: 409 }).status, 409);
  assert.equal(failureInfo({ code: 'ERR_NETWORK' }).code, undefined);
  assert.equal(failureInfo({ code: 'AI_lower' }).code, undefined);
  assert.equal(failureInfo({ code: 'AI_' + 'X'.repeat(61) }).code, undefined);
  assert.equal(failureInfo({ code: 'AI_CHAT_BUSY' }).code, 'AI_CHAT_BUSY');
  // response.data.code wins over the transport code
  assert.equal(failureInfo({ code: 'ERR_BAD_REQUEST', response: { data: { code: 'AI_TASK_COST_CHANGED' } } }).code, 'AI_TASK_COST_CHANGED');
  assert.equal(failureInfo({ code: 'AI_CHAT_BUSY', response: { data: { code: 5 } } }).code, undefined);
});

test('aiFailureKind maps every known code and status, codes beating statuses', () => {
  const cases = [
    [{ code: 'AI_TASK_INSUFFICIENT_CREDITS' }, 'credits'], [{ status: 402 }, 'credits'],
    [{ status: 409, code: 'AI_TASK_COST_CHANGED' }, 'costChanged'],
    [{ status: 409, code: 'AI_TASK_IDEMPOTENCY_CONFLICT' }, 'conflict'],
    [{ status: 409, code: 'AI_CHAT_BUSY' }, 'busy'], [{ status: 409 }, 'busy'],
    [{ status: 400, code: 'AI_MODEL_NOT_OFFERED' }, 'notOffered'],
    [{ status: 400, code: 'AI_TASK_REFERENCE_INVALID' }, 'reference'],
    [{ status: 503, code: 'AI_PROVIDER_UNAVAILABLE' }, 'unavailable'], [{ code: 'AI_CHAT_UNAVAILABLE' }, 'unavailable'], [{ status: 503 }, 'unavailable'],
    [{ status: 502, code: 'AI_PROVIDER_FAILED' }, 'providerFailed'], [{ status: 502 }, 'providerFailed'],
    [{ status: 400, code: 'AI_TASK_INVALID' }, 'invalid'], [{ status: 400 }, 'invalid'], [{ status: 413 }, 'invalid'],
    [{ status: 404 }, 'notFound'], [{ status: 429 }, 'rateLimited'],
    [{ status: 500 }, 'uncertain'], [{ status: 504 }, 'uncertain'], [{ status: 408 }, 'uncertain'],
    [new Error('Network Error'), 'uncertain'], [{ code: 'ERR_NETWORK' }, 'uncertain'], [undefined, 'uncertain'],
  ];
  for (const [error, kind] of cases) assert.equal(aiFailureKind(error), kind, JSON.stringify(error));
});

test('isDefiniteRejection: only 4xx other than 408 means nothing was created', () => {
  for (const status of [400, 401, 402, 403, 404, 409, 413, 422, 429, 499]) assert.equal(isDefiniteRejection({ status }), true, String(status));
  for (const status of [200, 302, 408, 500, 502, 503, 504, 599]) assert.equal(isDefiniteRejection({ status }), false, String(status));
  for (const error of [new Error('timeout'), { code: 'ECONNABORTED' }, null, undefined, { status: '400' }]) assert.equal(isDefiniteRejection(error), false);
});

test('submit attempt: key reused for the same request until a definite rejection clears it', () => {
  let n = 0;
  const create = () => `k${++n}`;
  let attempt = nextSubmitAttempt(null, 'body-1', create);
  // network error / 5xx: caller keeps `attempt`
  attempt = nextSubmitAttempt(attempt, 'body-1', create);
  attempt = nextSubmitAttempt(attempt, 'body-1', create);
  assert.equal(attempt.key, 'k1');
  assert.equal(n, 1);
  // 4xx: caller resets to null -> a fresh key
  assert.equal(nextSubmitAttempt(null, 'body-1', create).key, 'k2');
  // an edited request never inherits the uncertain key
  assert.equal(nextSubmitAttempt(attempt, 'body-2', create).key, 'k3');
  // default generator: valid per server rules (8-128 of [A-Za-z0-9_.:-])
  const key = nextSubmitAttempt(null, 'x').key;
  assert.match(key, /^[A-Za-z0-9_.:-]{8,128}$/);
  assert.notEqual(key, nextSubmitAttempt(null, 'x').key);
});
