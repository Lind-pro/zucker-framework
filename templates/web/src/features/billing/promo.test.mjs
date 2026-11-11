import assert from 'node:assert/strict';
import { test } from 'node:test';

// A small in-memory sessionStorage so the attempt storage path is exercised too.
const store = new Map();
globalThis.window = { sessionStorage: {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k),
  key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; },
} };

const { checkoutAttempt, rememberCheckoutOrder, completeCheckoutAttempt } = await import('./checkout-attempt.ts');
const { parsePricingCatalog } = await import('./pricing.ts');

const selection = { offerId: 'pack:p1:USD', providerId: 'stripe' };

test('a different promo code is a different purchase: new idempotency key, never the plain attempt', () => {
  const plain = checkoutAttempt('user-1', selection);
  const coded = checkoutAttempt('user-1', { ...selection, promoCode: 'spring20' });
  assert.notEqual(plain.key, coded.key);
  assert.equal(coded.promoCode, 'SPRING20');
  assert.equal(checkoutAttempt('user-1', { ...selection, promoCode: 'Spring20' }).key, coded.key, 'same code, any case, keeps one key');
  assert.notEqual(checkoutAttempt('user-1', { ...selection, promoCode: 'OTHER99' }).key, coded.key);
  assert.equal(checkoutAttempt('user-1', selection).key, plain.key);
  assert.notEqual(checkoutAttempt('user-2', { ...selection, promoCode: 'SPRING20' }).key, coded.key, 'attempts are per account');
});

test('a saved attempt under another code or tampered storage never supplies a purchase identity', () => {
  store.clear();
  const coded = checkoutAttempt('user-3', { ...selection, promoCode: 'SPRING20' });
  const storageKey = [...store.keys()][0];
  // Tamper: weak key, discount fields smuggled into the stored record.
  store.set(storageKey, JSON.stringify({ ...coded, key: 'short', payable: '0.01' }));
  const fresh = checkoutAttempt('user-3', { ...selection, promoCode: 'SPRING20', offerId: 'pack:p1:USD' });
  assert.match(fresh.key, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal('payable' in fresh, false);
  store.set(storageKey, '{not json');
  assert.match(checkoutAttempt('user-3', { ...selection, promoCode: 'SPRING20' }).key, /^[a-f0-9]{32}$/);
});

test('a completed order removes only its own attempt', () => {
  const a = checkoutAttempt('user-4', selection), b = checkoutAttempt('user-4', { ...selection, promoCode: 'AAA111' });
  rememberCheckoutOrder(a, 'order-a'); rememberCheckoutOrder(b, 'order-b');
  completeCheckoutAttempt('order-a');
  assert.notEqual(checkoutAttempt('user-4', selection).key, a.key);
  assert.equal(checkoutAttempt('user-4', { ...selection, promoCode: 'AAA111' }).key, b.key);
});

test('the pricing response can only switch the promo field on with the exact value "alias"', () => {
  const parse = (checkout) => parsePricingCatalog({ plans: [], packs: [], checkout }).checkout.promoCodes;
  assert.equal(parse({ promoCodes: 'alias' }), 'alias');
  for (const bad of [true, 'ALIAS', 'any', 1, null, ['alias'], {}, undefined]) assert.equal(parse({ promoCodes: bad }), 'none', String(bad));
  assert.equal(parsePricingCatalog({ plans: [], packs: [] }).checkout.promoCodes, 'none');
});
