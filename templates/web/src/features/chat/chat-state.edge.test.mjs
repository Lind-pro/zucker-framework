import assert from 'node:assert/strict';
import { test } from 'node:test';

const { chatReducer, initialChatState, isStreaming, parseSseData } = await import('./chat-state.ts');

const run = (state, ...actions) => actions.reduce(chatReducer, state);
const ev = (event, data) => ({ type: 'event', event, data });
const started = (...more) =>
  run(initialChatState, { type: 'send', content: 'hi', localId: 'L' }, ev('start', { messageId: 'a1', userMessageId: 'u1', providerId: 'p', model: 'm' }), ...more);

test('events before send, after settle, or for another message are ignored', () => {
  assert.equal(chatReducer(initialChatState, ev('delta', { text: 'x' })), initialChatState);
  const done = started(ev('delta', { text: 'A' }), ev('done', { messageId: 'a1', cost: 1 }));
  assert.equal(done.pending, null);
  assert.equal(run(done, ev('delta', { text: 'late' })), done);
  assert.equal(run(done, ev('error', { code: 'AI_PROVIDER_FAILED' })), done);
  const foreign = started(ev('done', { messageId: 'OTHER', cost: 9 }), ev('error', { messageId: 'OTHER', code: 'AI_PROVIDER_FAILED' }));
  assert.equal(foreign.pending?.assistantId, 'a1');
  assert.equal(foreign.messages[1].status, 'STREAMING');
});

test('start without ids is ignored; empty or non-string deltas change nothing', () => {
  const s = run(initialChatState, { type: 'send', content: 'hi', localId: 'L' });
  assert.equal(chatReducer(s, ev('start', { messageId: 'a1' })), s);
  assert.equal(chatReducer(s, ev('start', null)), s);
  for (const data of [{ text: '' }, { text: 5 }, {}, null, 'x'])
    assert.deepEqual(chatReducer(s, ev('delta', data)).messages, s.messages);
  assert.equal(chatReducer(s, ev('unknown', {})), s);
});

test('done with malformed usage/cost defaults to zero cost and null usage', () => {
  const s = started(ev('done', { messageId: 'a1', usage: { input: 'x' }, cost: Number.NaN }));
  assert.equal(s.messages[1].cost, 0);
  assert.equal(s.messages[1].usage, null);
  assert.equal(s.lastCost, 0);
  assert.equal(s.messages[1].status, 'COMPLETE');
});

test('error event: ABORTED code maps to ABORTED, missing code to AI_PROVIDER_FAILED, partial text kept', () => {
  const aborted = started(ev('delta', { text: 'part' }), ev('error', { code: 'AI_CHAT_ABORTED', cost: 1 }));
  assert.equal(aborted.messages[1].status, 'ABORTED');
  assert.equal(aborted.messages[1].content, 'part');
  const failed = started(ev('error', {}));
  assert.equal(failed.error, 'AI_PROVIDER_FAILED');
  assert.equal(failed.messages[1].status, 'FAILED');
});

test('stream closing without done is interrupted; closing before start interrupts the local pair', () => {
  const noStart = run(initialChatState, { type: 'send', content: 'x', localId: 'L' }, { type: 'ended' });
  assert.equal(noStart.error, 'AI_CHAT_INTERRUPTED');
  assert.equal(noStart.pending, null);
  assert.deepEqual(noStart.messages.map((m) => [m.role, m.status]), [['user', 'COMPLETE'], ['assistant', 'FAILED']]);
  const mid = started(ev('delta', { text: 'half' }), { type: 'ended' });
  assert.equal(mid.messages[1].status, 'FAILED');
  assert.equal(mid.messages[1].errorCode, 'AI_CHAT_INTERRUPTED');
  assert.equal(mid.messages[1].content, 'half');
  assert.equal(isStreaming(mid), false);
});

test('rejected removes only the optimistic pair of the turn and keeps history; without a turn it only sets the error', () => {
  const history = [{ id: 'h1', role: 'user', content: 'old', reasoning: null, status: 'COMPLETE' }];
  const loaded = run(initialChatState, { type: 'load', messages: history });
  const rejected = run(loaded, { type: 'send', content: 'new', localId: 'L' }, { type: 'rejected', reason: 'credits' });
  assert.deepEqual(rejected.messages, history);
  assert.equal(rejected.error, 'credits');
  assert.equal(rejected.pending, null);
  const idle = chatReducer(loaded, { type: 'rejected', reason: 'busy' });
  assert.deepEqual(idle.messages, history);
  assert.equal(idle.error, 'busy');
});

test('load resets everything (account/chat switch); dismiss clears only the error; stopped is a no-op when idle', () => {
  const busy = started(ev('delta', { text: 'x' }), { type: 'ended' });
  const loaded = chatReducer({ ...busy, lastCost: 3 }, { type: 'load', messages: [] });
  assert.deepEqual(loaded, initialChatState);
  assert.equal(chatReducer(busy, { type: 'dismiss' }).error, null);
  assert.equal(chatReducer(initialChatState, { type: 'stopped' }), initialChatState);
  assert.equal(chatReducer(initialChatState, { type: 'ended' }), initialChatState);
});

test('parseSseData rejects arrays, scalars, null and invalid JSON', () => {
  for (const data of ['[1]', '3', 'null', '"s"', '{bad', '']) assert.deepEqual(parseSseData(data), {}, data);
  assert.deepEqual(parseSseData('{"a":1}'), { a: 1 });
});
