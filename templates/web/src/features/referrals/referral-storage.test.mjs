import assert from 'node:assert/strict';
import { test } from 'node:test';

const { REFERRAL_MAX_AGE_MS, REFERRAL_STORAGE_KEY, captureReferralCode, clearReferralCode, isFinalClaimFailure, readReferralCode, sanitizeReferralCode } =
  await import('./referral-storage.ts');

const memory = () => { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map }; };

test('sanitizeReferralCode keeps 6-16 [A-Z0-9] after trim and upper-casing', () => {
  assert.equal(sanitizeReferralCode(' abcd2345 '), 'ABCD2345');
  for (const bad of ['ABC12', 'A'.repeat(17), 'ABCD-123', '<script>', '', null, 42, 'ä'.repeat(8)]) assert.equal(sanitizeReferralCode(bad), null);
});

test('first touch wins inside the window and is replaced after it', () => {
  const storage = memory(), now = 1_000_000_000_000;
  captureReferralCode('?ref=FIRST234', storage, now);
  captureReferralCode('?ref=SECOND23', storage, now + 1000);
  assert.equal(readReferralCode(storage, now + 1000), 'FIRST234');
  captureReferralCode('?ref=SECOND23', storage, now + REFERRAL_MAX_AGE_MS + 1);
  assert.equal(readReferralCode(storage, now + REFERRAL_MAX_AGE_MS + 1), 'SECOND23');
  clearReferralCode(storage);
  assert.equal(storage.map.has(REFERRAL_STORAGE_KEY), false);
});

test('invalid, future-dated or corrupt entries are ignored', () => {
  const storage = memory(), now = 1_000_000_000_000;
  captureReferralCode('?ref=bad!', storage, now);
  assert.equal(storage.map.size, 0);
  storage.setItem(REFERRAL_STORAGE_KEY, JSON.stringify({ code: 'ABCDEFGH', at: now + 10 }));
  assert.equal(readReferralCode(storage, now), null);
  storage.setItem(REFERRAL_STORAGE_KEY, '{oops');
  assert.equal(readReferralCode(storage, now), null);
  assert.equal(readReferralCode(null, now), null);
});

test('only definitive refusals drop the stored code', () => {
  assert.equal(isFinalClaimFailure(400), true);
  assert.equal(isFinalClaimFailure(403), true);
  for (const keep of [401, 408, 429, 500, 503, undefined]) assert.equal(isFinalClaimFailure(keep), false);
});
