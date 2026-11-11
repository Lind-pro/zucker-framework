import assert from 'node:assert/strict';
import { test } from 'node:test';

const { inboxReducer, initialInboxState, shouldPoll, badgeLabel, safeHref, pageCount } = await import('./inbox-state.ts');
const { describeNotification } = await import('./copy.ts');

const item = (id, isRead = false) => ({ id, type: 'order.paid', params: { credits: 5 }, href: '/billing/orders', isRead, readAt: isRead ? 't' : null, createdAt: '2026-11-10T00:00:00Z' });
const loaded = (state, data, unreadCount, total = data.length) => inboxReducer(state, { type: 'loaded', page: { data, total, unreadCount } });

test('read, read-all and archive keep counts consistent', () => {
  let state = loaded(initialInboxState, [item('a'), item('b'), item('c', true)], 2);
  state = inboxReducer(state, { type: 'read', id: 'a', readAt: 'now' });
  assert.equal(state.unreadCount, 1);
  assert.equal(inboxReducer(state, { type: 'read', id: 'a', readAt: 'again' }), state);
  state = inboxReducer(state, { type: 'archived', id: 'b' });
  assert.deepEqual([state.unreadCount, state.total, state.items.length], [0, 2, 2]);
  state = inboxReducer(state, { type: 'readAll', readAt: 'now' });
  assert.ok(state.items.every((value) => value.isRead));
});

test('unread filter drops rows once read', () => {
  let state = inboxReducer(initialInboxState, { type: 'load', page: 1, unreadOnly: true });
  state = loaded(state, [item('a'), item('b')], 2);
  state = inboxReducer(state, { type: 'read', id: 'a', readAt: 'now' });
  assert.deepEqual([state.items.map((value) => value.id), state.total, state.unreadCount], [['b'], 1, 1]);
  state = inboxReducer(state, { type: 'readAll', readAt: 'now' });
  assert.deepEqual([state.items, state.total], [[], 0]);
});

test('polling, badge, href and page helpers', () => {
  assert.equal(shouldPoll({ signedIn: true, visibility: 'visible' }), true);
  assert.equal(shouldPoll({ signedIn: true, visibility: 'hidden' }), false);
  assert.equal(shouldPoll({ signedIn: false, visibility: 'visible' }), false);
  assert.deepEqual([badgeLabel(0), badgeLabel(3), badgeLabel(150), badgeLabel(null)], [null, '3', '99+', null]);
  assert.equal(safeHref('/billing/orders'), '/billing/orders');
  for (const bad of ['//evil.example', 'https://evil.example', '/a\\b', 'javascript:alert(1)', '/a b', null]) assert.equal(safeHref(bad), null);
  assert.equal(pageCount({ total: 41 }), 3);
});

test('copy renders known types with params and falls back for unknown ones', () => {
  assert.match(describeNotification('en', 'order.paid', { credits: 1200 }).body, /1,200 credits/);
  assert.equal(describeNotification('zh', 'ai.task.completed', { kind: 'image' }).body, '你的图片已生成。');
  assert.equal(describeNotification('en', 'something.new', {}).title, 'Notification');
  assert.equal(describeNotification('en', 'constructor', {}).title, 'Notification');
  assert.ok(describeNotification('en', 'feedback.replied', null).title);
  assert.ok(describeNotification('en', 'referral.rewarded', { credits: 10 }).body.includes('10'));
});
