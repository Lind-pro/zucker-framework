import assert from 'node:assert/strict';
import { test } from 'node:test';

const { feedbackFailure, submission, validateFeedback, safePagePath } = await import('./form-state.ts');
const { isDefiniteRejection, nextSubmitAttempt } = await import('../ai/errors.ts');

/** Replays FeedbackForm.send(): the key is kept after an uncertain failure and dropped after a definite one or a success. */
function formFlow() {
  let attempt = null;
  const keys = [];
  let counter = 0;
  return {
    keys,
    async send(body, outcome) {
      attempt = nextSubmitAttempt(attempt, JSON.stringify(body), () => `fb-key-${++counter}`);
      keys.push(attempt.key);
      if (outcome === 'ok') { attempt = null; return 'sent'; }
      if (isDefiniteRejection(outcome)) attempt = null;
      return feedbackFailure(outcome);
    },
  };
}
const body = (text = 'It broke', from = '/account/files') => submission('bug', text, from, 'en');

test('an uncertain failure keeps the Idempotency-Key for the identical retry', async () => {
  for (const uncertain of [{ code: 'ERR_NETWORK' }, { status: 500 }, { status: 502 }, { status: 503 }, { status: 504 }, { status: 408 }, {}, null, undefined]) {
    const flow = formFlow();
    assert.equal(await flow.send(body(), uncertain), 'uncertain');
    assert.equal(await flow.send(body(), uncertain), 'uncertain');
    assert.equal(await flow.send(body(), 'ok'), 'sent');
    assert.equal(new Set(flow.keys).size, 1, JSON.stringify(uncertain));
    // After success the next message is a new submission with a new key.
    await flow.send(body(), 'ok');
    assert.equal(new Set(flow.keys).size, 2);
  }
});

test('a definite rejection drops the key so a corrected retry creates a new item', async () => {
  for (const definite of [{ status: 400 }, { status: 403, response: { data: { code: 'FEEDBACK_DISABLED' } } }, { status: 409, response: { data: { code: 'FEEDBACK_TOO_MANY_OPEN' } } },
    { status: 409, response: { data: { code: 'FEEDBACK_IDEMPOTENCY_CONFLICT' } } }, { status: 429 }]) {
    const flow = formFlow();
    await flow.send(body(), definite);
    await flow.send(body(), 'ok');
    assert.equal(new Set(flow.keys).size, 2, JSON.stringify(definite));
  }
});

test('editing the text, type, locale or page after an uncertain failure uses a new key; whitespace-only edits do not', async () => {
  const flow = formFlow();
  await flow.send(body('first'), { status: 500 });
  await flow.send(body('  first  '), { status: 500 });
  assert.equal(new Set(flow.keys).size, 1);
  await flow.send(body('first!'), { status: 500 });
  await flow.send(submission('idea', 'first!', '/account/files', 'en'), { status: 500 });
  await flow.send(submission('idea', 'first!', '/account/files', 'zh'), { status: 500 });
  await flow.send(submission('idea', 'first!', '/billing', 'zh'), { status: 500 });
  assert.equal(new Set(flow.keys).size, 5);
});

test('submission trims, drops unsafe pages and never invents fields', () => {
  assert.deepEqual(submission('idea', '  hi  ', '/zh/account', 'zh'), { type: 'idea', message: 'hi', pagePath: '/zh/account', locale: 'zh' });
  for (const from of ['//evil.example', 'https://evil.example/x', '/a?token=abc', '/a#frag', '/a\\b', 'javascript:alert(1)', '/a b', '/a\nb', `/${'a'.repeat(512)}`, '', null, undefined, 42])
    assert.deepEqual(Object.keys(submission('idea', 'hi', from, 'en')).sort(), ['locale', 'message', 'type'], String(from));
  assert.equal(safePagePath(`/${'a'.repeat(511)}`)?.length, 512);
});

test('validateFeedback boundaries: 4000 characters pass, 4001 fail, whitespace is trimmed first, unknown types fail', () => {
  assert.equal(validateFeedback('other', 'x'.repeat(4000)), null);
  assert.equal(validateFeedback('other', ` ${'x'.repeat(4000)} `), null);
  assert.equal(validateFeedback('other', 'x'.repeat(4001)), 'tooLong');
  assert.equal(validateFeedback('other', '\n\t '), 'empty');
  for (const type of ['', 'BUG', 'bug ', undefined, null, '__proto__', 'constructor']) assert.equal(validateFeedback(type, 'hi'), 'type', String(type));
});

test('feedbackFailure maps statuses, ignores non-FEEDBACK codes and never trusts server text', () => {
  assert.equal(feedbackFailure({ status: 409, response: { data: { code: 'FEEDBACK_IDEMPOTENCY_CONFLICT' } } }), 'conflict');
  assert.equal(feedbackFailure({ status: 400 }), 'invalid');
  assert.equal(feedbackFailure({ status: 403 }), 'disabled');
  assert.equal(feedbackFailure({ status: 429 }), 'rateLimited');
  assert.equal(feedbackFailure({ _httpStatus: 429 }), 'rateLimited');
  // A spoofed or malformed code does not select a branch; the status decides.
  assert.equal(feedbackFailure({ status: 500, response: { data: { code: 'AI_TASK_COST_CHANGED' } } }), 'uncertain');
  assert.equal(feedbackFailure({ status: 500, response: { data: { code: 'feedback_disabled' } } }), 'uncertain');
  assert.equal(feedbackFailure({ status: 500, response: { data: { code: 'FEEDBACK_DISABLED<script>' } } }), 'uncertain');
  assert.equal(feedbackFailure({ status: '429' }), 'uncertain');
  assert.equal(feedbackFailure('boom'), 'uncertain');
  assert.equal(feedbackFailure(undefined), 'uncertain');
});
