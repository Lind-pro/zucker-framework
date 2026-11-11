import assert from 'node:assert/strict';
import { test } from 'node:test';

const { feedbackEnabled, feedbackFailure, safePagePath, submission, validateFeedback } = await import('./form-state.ts');

test('validateFeedback checks type and trimmed length', () => {
  assert.equal(validateFeedback('bug', 'hello'), null);
  assert.equal(validateFeedback('spam', 'hello'), 'type');
  assert.equal(validateFeedback('idea', '   '), 'empty');
  assert.equal(validateFeedback('idea', 'x'.repeat(4001)), 'tooLong');
});

test('safePagePath keeps same-site paths only', () => {
  assert.equal(safePagePath('/zh/account/files'), '/zh/account/files');
  for (const value of ['//evil.example', 'https://evil.example', '/a\\b', '/a?t=1', '/a#x', '/a b', 'rel', '', null]) assert.equal(safePagePath(value), undefined);
  assert.deepEqual(submission('bug', '  hi ', '//evil', 'en'), { type: 'bug', message: 'hi', locale: 'en' });
});

test('feedbackFailure trusts FEEDBACK_ codes and statuses', () => {
  assert.equal(feedbackFailure({ status: 403, response: { data: { code: 'FEEDBACK_DISABLED' } } }), 'disabled');
  assert.equal(feedbackFailure({ status: 409, response: { data: { code: 'FEEDBACK_TOO_MANY_OPEN' } } }), 'tooManyOpen');
  assert.equal(feedbackFailure({ status: 429 }), 'rateLimited');
  assert.equal(feedbackFailure({ code: 'ERR_NETWORK' }), 'uncertain');
});

test('feedbackEnabled defaults to enabled unless the policy says false', () => {
  assert.equal(feedbackEnabled({ policies: { feedback: { revision: 2, values: { enabled: false } } } }), false);
  assert.equal(feedbackEnabled({ policies: {} }), true);
  assert.equal(feedbackEnabled(null), true);
});
