import assert from 'node:assert/strict';
import { test } from 'node:test';

const { REFERRAL_MAX_AGE_MS, REFERRAL_STORAGE_KEY, captureReferralCode, clearReferralCode, isFinalClaimFailure, readReferralCode, sanitizeReferralCode } =
  await import('./referral-storage.ts');

const NOW = 1_800_000_000_000;
const memory = () => { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map }; };

/** Replays ReferralClaim: read the stored code, claim once, clear only after success or a definitive refusal. */
async function claimOnce(storage, outcome, now = NOW) {
  const code = readReferralCode(storage, now);
  if (!code) return 'no-code';
  if (outcome === 'ok') { clearReferralCode(storage); return 'bound'; }
  if (isFinalClaimFailure(outcome)) clearReferralCode(storage);
  return 'failed';
}

test('401 and 429 keep the stored code for the next visit; success and definitive refusals clear it', async () => {
  for (const [status, kept] of [[401, true], [429, true], [408, true], [500, true], [502, true], [503, true], [undefined, true], [400, false], [403, false], [404, false], [410, false], [422, false], ['ok', false]]) {
    const storage = memory();
    captureReferralCode('?ref=ABCD2345', storage, NOW);
    await claimOnce(storage, status);
    assert.equal(readReferralCode(storage, NOW + 1000) !== null, kept, `status ${status}`);
  }
});

test('a kept code survives until the attribution window closes, then is ignored', async () => {
  const storage = memory();
  captureReferralCode('?ref=ABCD2345', storage, NOW);
  await claimOnce(storage, 429);
  assert.equal(readReferralCode(storage, NOW + REFERRAL_MAX_AGE_MS), 'ABCD2345');
  assert.equal(readReferralCode(storage, NOW + REFERRAL_MAX_AGE_MS + 1), null);
  assert.equal(await claimOnce(storage, 'ok', NOW + REFERRAL_MAX_AGE_MS + 1), 'no-code');
});

test('first touch wins: a later link or a refused claim does not replace a live code; a cleared one can be replaced', () => {
  const storage = memory();
  captureReferralCode('?ref=FIRST234', storage, NOW);
  captureReferralCode('?utm_source=x&ref=second23', storage, NOW + 5);
  assert.equal(readReferralCode(storage, NOW + 5), 'FIRST234');
  clearReferralCode(storage);
  captureReferralCode('?utm_source=x&ref=second23', storage, NOW + 10);
  assert.equal(readReferralCode(storage, NOW + 10), 'SECOND23');
});

test('capture ignores malformed, oversized and repeated parameters, and never throws when storage is denied', () => {
  const storage = memory();
  for (const search of ['', '?', '?ref=', '?ref=ab', '?ref=' + 'A'.repeat(17), '?ref=A%20B%20C%20D', '?ref=<script>alert(1)</script>', '?ref=ABCD-234', '?REF=ABCD2345', '?xref=ABCD2345'])
    captureReferralCode(search, storage, NOW);
  assert.equal(storage.map.size, 0);
  captureReferralCode('?ref=AAAAAAAA&ref=BBBBBBBB', storage, NOW);
  assert.equal(readReferralCode(storage, NOW), 'AAAAAAAA');
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => captureReferralCode('?ref=ABCD2345', denied, NOW));
  assert.equal(readReferralCode(denied, NOW), null);
  assert.doesNotThrow(() => clearReferralCode(denied));
  assert.doesNotThrow(() => captureReferralCode('?ref=ABCD2345', null, NOW));
});

test('a stored entry with a tampered shape is ignored', () => {
  const storage = memory();
  for (const value of ['null', '[]', '"ABCD2345"', '{"code":"ABCD2345"}', `{"code":"ABCD2345","at":"${NOW}"}`, `{"code":42,"at":${NOW}}`, `{"code":"<x>","at":${NOW}}`, `{"code":"ABCD2345","at":-1}`, '']) {
    storage.setItem(REFERRAL_STORAGE_KEY, value);
    assert.equal(readReferralCode(storage, NOW), null, value);
  }
});

test('sanitizeReferralCode matches the server shape (6-16 of A-Z0-9) at the boundaries', () => {
  assert.equal(sanitizeReferralCode('ABCDEF'), 'ABCDEF');
  assert.equal(sanitizeReferralCode('A'.repeat(16)), 'A'.repeat(16));
  assert.equal(sanitizeReferralCode('ABCDE'), null);
  assert.equal(sanitizeReferralCode('A'.repeat(17)), null);
  assert.equal(sanitizeReferralCode('abcdef\n'), 'ABCDEF');
  assert.equal(sanitizeReferralCode('ABC\nDEF'), null);
  assert.equal(sanitizeReferralCode(`${' '.repeat(60)}ABCDEF${' '.repeat(10)}`), null); // longer than 64 characters before trimming
});
