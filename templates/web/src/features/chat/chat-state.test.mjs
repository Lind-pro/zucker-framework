import assert from 'node:assert/strict';
import { test } from 'node:test';

const { chatReducer, initialChatState, isStreaming, parseSseData } = await import('./chat-state.ts');

const run = (state, ...actions) => actions.reduce(chatReducer, state);
const ev = (event, data) => ({ type: 'event', event, data });

test('a full turn: start renames ids, reasoning and deltas append, done settles with cost', () => {
  const state = run(
    initialChatState,
    { type: 'send', content: 'Hello', localId: '1' },
    ev('start', { chatId: 'c1', messageId: 'a1', userMessageId: 'u1', providerId: 'p', model: 'm', held: 2 }),
    ev('reasoning', { text: 'Think ' }),
    ev('reasoning', { text: 'more' }),
    ev('delta', { text: 'Hi' }),
    ev('delta', { text: ' there' }),
  );
  assert.equal(isStreaming(state), true);
  assert.deepEqual(state.pending, { userId: 'u1', assistantId: 'a1' });
  assert.deepEqual(state.messages.map((m) => [m.id, m.role, m.content, m.status]), [
    ['u1', 'user', 'Hello', 'COMPLETE'],
    ['a1', 'assistant', 'Hi there', 'STREAMING'],
  ]);
  assert.equal(state.messages[1].reasoning, 'Think more');
  assert.equal(state.messages[1].model, 'm');

  const done = run(state, ev('done', { messageId: 'a1', usage: { input: 3, output: 5 }, cost: 4 }), { type: 'ended' });
  assert.equal(isStreaming(done), false);
  assert.equal(done.messages[1].status, 'COMPLETE');
  assert.equal(done.messages[1].cost, 4);
  assert.deepEqual(done.messages[1].usage, { input: 3, output: 5 });
  assert.equal(done.lastCost, 4);
  assert.equal(done.error, null);
  // Events after the turn settled change nothing.
  assert.equal(run(done, ev('delta', { text: 'late' })), done);
});

test('error event keeps partial text and records the code and charged cost', () => {
  const state = run(
    initialChatState,
    { type: 'send', content: 'Q', localId: '2' },
    ev('start', { messageId: 'a2', userMessageId: 'u2' }),
    ev('delta', { text: 'Part' }),
    ev('error', { code: 'AI_PROVIDER_FAILED', message: 'x', messageId: 'a2', usage: { input: 1, output: 1 }, cost: 1 }),
  );
  assert.equal(state.messages[1].content, 'Part');
  assert.equal(state.messages[1].status, 'FAILED');
  assert.equal(state.messages[1].errorCode, 'AI_PROVIDER_FAILED');
  assert.equal(state.error, 'AI_PROVIDER_FAILED');
  assert.equal(state.pending, null);
});

test('stop marks the answer aborted; a stream that closes early is interrupted', () => {
  const streaming = run(initialChatState, { type: 'send', content: 'Q', localId: '3' }, ev('start', { messageId: 'a3', userMessageId: 'u3' }), ev('delta', { text: 'Half' }));
  const stopped = chatReducer(streaming, { type: 'stopped' });
  assert.equal(stopped.messages[1].status, 'ABORTED');
  assert.equal(stopped.messages[1].content, 'Half');
  assert.equal(isStreaming(stopped), false);
  const ended = chatReducer(streaming, { type: 'ended' });
  assert.equal(ended.messages[1].status, 'FAILED');
  assert.equal(ended.error, 'AI_CHAT_INTERRUPTED');
});

test('pre-stream rejection removes the optimistic pair', () => {
  const state = run(
    { ...initialChatState, messages: [{ id: 'old', role: 'user', content: 'before', reasoning: null, status: 'COMPLETE' }] },
    { type: 'send', content: 'Q', localId: '4' },
    { type: 'rejected', reason: 'credits' },
  );
  assert.deepEqual(state.messages.map((m) => m.id), ['old']);
  assert.equal(state.error, 'credits');
  assert.equal(chatReducer(state, { type: 'dismiss' }).error, null);
});

test('ignores malformed and foreign events; a second send during a turn is ignored', () => {
  const started = run(initialChatState, { type: 'send', content: 'Q', localId: '5' }, ev('start', { messageId: 'a5', userMessageId: 'u5' }));
  assert.equal(run(started, ev('start', { messageId: 7 })), started);
  assert.equal(run(started, ev('delta', { text: 42 })), started);
  assert.equal(run(started, ev('delta', null)), started);
  assert.equal(run(started, ev('ping', {})), started);
  assert.equal(run(started, ev('done', { messageId: 'other' })), started);
  assert.equal(run(started, { type: 'send', content: 'again', localId: '6' }), started);
  assert.equal(run(initialChatState, ev('delta', { text: 'stray' })), initialChatState);
});

test('parseSseData accepts only JSON objects', () => {
  assert.deepEqual(parseSseData('{"text":"a"}'), { text: 'a' });
  assert.deepEqual(parseSseData('[1]'), {});
  assert.deepEqual(parseSseData('not json'), {});
  assert.deepEqual(parseSseData(''), {});
});

test('a reload after a refused turn keeps the refusal visible; a normal load clears it', () => {
  let state = chatReducer(initialChatState, { type: 'send', content: 'hi', localId: 'k' });
  state = chatReducer(state, { type: 'rejected', reason: 'unavailable' });
  assert.equal(chatReducer(state, { type: 'load', messages: [], keepError: true }).error, 'unavailable');
  assert.equal(chatReducer(state, { type: 'load', messages: [] }).error, null);
});
