import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const { describeNotification, inboxCopy } = await import('./copy.ts');
const { safeHref, badgeLabel, pageCount, inboxReducer, initialInboxState } = await import('./inbox-state.ts');

// The server list is the source of truth for the types the web app must be able to render.
const serverFile = new URL('../../../../server/src/inbox/inbox-types.ts', import.meta.url);
const server = existsSync(serverFile) ? await import(serverFile.href) : null;

test('every notification type the server can emit has an English and a Chinese line', { skip: !server }, () => {
  const types = Object.keys(server.INBOX_TYPES);
  assert.ok(types.length >= 7);
  const sample = { credits: 1200, kind: 'image', outcome: 'succeeded' };
  for (const type of types) for (const locale of ['en', 'zh']) {
    const line = describeNotification(locale, type, sample);
    assert.ok(line.title && line.body, `${locale} ${type}`);
    assert.notEqual(line.title, inboxCopy(locale).generic.title, `${locale} ${type} falls back to the generic line`);
  }
});

test('copy renders text only: hostile or malformed params never throw and never leak markup into the line', () => {
  const hostile = [null, undefined, 'text', 42, [], [1], { credits: '<img src=x onerror=1>' }, { credits: NaN }, { credits: Infinity }, { credits: -5 }, { credits: 1e21 },
    { kind: '<b>x</b>' }, { kind: { toString: () => 'image' } }, { __proto__: { credits: 9 } }, JSON.parse('{"__proto__": {"credits": 9}}')];
  for (const type of ['order.paid', 'subscription.renewed', 'refund.settled', 'ai.task.completed', 'ai.task.failed', 'feedback.replied', 'referral.rewarded', 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty'])
    for (const locale of ['en', 'zh', 'fr', '', undefined])
      for (const params of hostile) {
        const line = describeNotification(locale, type, params);
        assert.equal(typeof line.title, 'string');
        assert.equal(typeof line.body, 'string');
        assert.doesNotMatch(line.title + line.body, /<|onerror|undefined|NaN|\[object/);
      }
});

test('an unknown kind falls back to a neutral word instead of echoing the value', () => {
  assert.doesNotMatch(describeNotification('en', 'ai.task.completed', { kind: 'secret-model-name' }).body, /secret/);
  assert.match(describeNotification('en', 'ai.task.completed', { kind: 'video' }).body, /video/);
  assert.match(describeNotification('zh', 'ai.task.failed', { kind: 'audio' }).body, /音频/);
});

test('safeHref accepts the paths the server emits and refuses anything that could leave the site', () => {
  for (const href of ['/billing/orders', '/billing/subscriptions', '/account/tasks', '/account/feedback', '/account/referrals', '/', '/a?x=1&y=%20#z']) assert.equal(safeHref(href), href);
  for (const href of ['//evil.example', '/\\evil.example', 'https://evil.example', 'http://x', 'javascript:alert(1)', 'data:text/html,x', '/a b', '/a<script>', '/a\nb', '/%2f%2fevil.example', '',
    `/${'a'.repeat(512)}`, 'billing/orders', ' /billing', null, undefined, 5, {}, ['/a']]) assert.equal(safeHref(href), null, String(href));
});

test('static server hrefs all pass the web check', { skip: !server }, () => {
  for (const href of ['/billing/orders', '/billing/subscriptions', '/account/tasks', '/account/feedback', '/account/referrals']) {
    assert.equal(server.isInboxHref(href), true, href);
    assert.equal(safeHref(href), href);
  }
  // Whatever the server refuses as an emit href, the web check refuses too when it is an external or malformed target.
  for (const href of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/a b', '/\\evil']) {
    assert.equal(server.isInboxHref(href), false);
    assert.equal(safeHref(href), null);
  }
});

test('badge and paging helpers cope with odd numbers', () => {
  assert.deepEqual([badgeLabel(99), badgeLabel(100), badgeLabel(-1), badgeLabel(NaN), badgeLabel(Infinity), badgeLabel(2.9), badgeLabel('5')], ['99', '99+', null, null, null, '2', null]);
  assert.deepEqual([pageCount({ total: 0 }), pageCount({ total: 1 }), pageCount({ total: 20 }), pageCount({ total: 21 })], [1, 1, 1, 2]);
});

test('reducer: counts never go negative on repeated or unknown actions, and unknown ids change nothing', () => {
  const item = (id, isRead = false) => ({ id, type: 'order.paid', params: {}, href: null, isRead, readAt: isRead ? 't' : null, createdAt: 't' });
  let state = inboxReducer(initialInboxState, { type: 'loaded', page: { data: [item('a'), item('b', true)], total: 2, unreadCount: 1 } });
  state = inboxReducer(state, { type: 'read', id: 'a', readAt: 'now' });
  const again = inboxReducer(state, { type: 'read', id: 'a', readAt: 'later' });
  assert.equal(again.unreadCount, 0);
  assert.equal(inboxReducer(again, { type: 'read', id: 'missing', readAt: 'x' }).unreadCount, 0);
  assert.equal(inboxReducer(again, { type: 'archived', id: 'missing' }).total, again.total);
  const archivedRead = inboxReducer(again, { type: 'archived', id: 'b' });
  assert.equal(archivedRead.unreadCount, 0);
  assert.equal(archivedRead.items.length, 1);
  assert.equal(inboxReducer(archivedRead, { type: 'nonsense' }), archivedRead);
});
