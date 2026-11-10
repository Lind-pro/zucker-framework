import { describe, expect, it } from 'vitest';
import { creditExpiresAt, paidPeriodEnd, validateCreditFulfillmentPolicy } from '../src/billing/ledger';

/** Pure unit checks of the credit fulfillment policy: no database, no network. */
const DAY = 86_400_000;
const planSnapshot = (extra: object = {}) => ({ planId: 'p', slug: 's', revision: 1, interval: 'month', currency: 'USD', amount: '9.00', termDays: null,
  providerId: 'x', providerRef: 'r', credits: 5, creditExpiry: 'period', ...extra });

describe('validateCreditFulfillmentPolicy', () => {
  it('accepts a plain credit policy and normalises an absent expiry to null', () => {
    expect(validateCreditFulfillmentPolicy({ credits: 10 })).toEqual({ credits: 10, expiresInDays: null });
    expect(validateCreditFulfillmentPolicy({ credits: 10, expiresInDays: 30, grantBasis: 'payment' })).toEqual({ credits: 10, expiresInDays: 30, grantBasis: 'payment' });
  });
  it('accepts a pack policy with its audit snapshot only without a plan', () => {
    expect(validateCreditFulfillmentPolicy({ credits: 100, expiresInDays: null, pack: { packId: 'k' } })).toMatchObject({ credits: 100 });
    expect(() => validateCreditFulfillmentPolicy({ credits: 100, pack: { packId: 'k' }, plan: planSnapshot() })).toThrow(TypeError);
    expect(() => validateCreditFulfillmentPolicy({ credits: 100, pack: 'k' })).toThrow(TypeError);
    expect(() => validateCreditFulfillmentPolicy({ credits: 100, pack: [] })).toThrow(TypeError);
  });
  it('requires positive credits for packs and static offers, allows zero only for plans', () => {
    expect(() => validateCreditFulfillmentPolicy({ credits: 0 })).toThrow(TypeError);
    expect(() => validateCreditFulfillmentPolicy({ credits: 0, pack: { packId: 'k' } })).toThrow(TypeError);
    expect(validateCreditFulfillmentPolicy({ credits: 0, plan: planSnapshot({ credits: 0 }) })).toMatchObject({ credits: 0 });
    expect(() => validateCreditFulfillmentPolicy({ credits: -1, plan: planSnapshot() })).toThrow(TypeError);
  });
  it.each([1.5, '10', null, undefined, NaN, Infinity, 2_147_483_648])('rejects credits %s', credits => {
    expect(() => validateCreditFulfillmentPolicy({ credits })).toThrow(TypeError);
  });
  it('accepts the maximum credit amount', () => {
    expect(validateCreditFulfillmentPolicy({ credits: 2_147_483_647 }).credits).toBe(2_147_483_647);
  });
  it.each([0, -1, 1.5, '30', 100_000_001])('rejects expiresInDays %s', expiresInDays => {
    expect(() => validateCreditFulfillmentPolicy({ credits: 1, expiresInDays })).toThrow(TypeError);
  });
  it('allows expiresAtPeriodEnd only as true, only on plan policies and never together with expiresInDays', () => {
    const plan = planSnapshot();
    expect(validateCreditFulfillmentPolicy({ credits: 5, expiresAtPeriodEnd: true, plan })).toMatchObject({ expiresAtPeriodEnd: true, expiresInDays: null });
    expect(validateCreditFulfillmentPolicy({ credits: 5, expiresInDays: null, expiresAtPeriodEnd: true, plan })).toMatchObject({ expiresAtPeriodEnd: true });
    expect(() => validateCreditFulfillmentPolicy({ credits: 5, expiresAtPeriodEnd: true })).toThrow(TypeError); // no plan
    expect(() => validateCreditFulfillmentPolicy({ credits: 5, expiresAtPeriodEnd: true, pack: { packId: 'k' } })).toThrow(TypeError);
    expect(() => validateCreditFulfillmentPolicy({ credits: 5, expiresAtPeriodEnd: false, plan })).toThrow(TypeError);
    expect(() => validateCreditFulfillmentPolicy({ credits: 5, expiresAtPeriodEnd: 'true', plan })).toThrow(TypeError);
    expect(() => validateCreditFulfillmentPolicy({ credits: 5, expiresAtPeriodEnd: true, expiresInDays: 30, plan })).toThrow(TypeError);
  });
  it('refuses unknown keys, non-object input and a bad grant basis', () => {
    for (const bad of [null, undefined, [], 'x', 1, { credits: 1, bonus: 1 }, { credits: 1, grantBasis: 'later' }, { credits: 1, plan: 'p' }, { credits: 1, plan: [] }])
      expect(() => validateCreditFulfillmentPolicy(bad)).toThrow(TypeError);
  });
});

describe('creditExpiresAt', () => {
  const at = new Date('2026-03-01T00:00:00Z');
  it('is never, N days after the grant, or the period end', () => {
    expect(creditExpiresAt({ credits: 1, expiresInDays: null }, at, () => { throw new Error('unused'); })).toBeNull();
    expect(creditExpiresAt({ credits: 1, expiresInDays: 30 }, at, () => null)).toEqual(new Date(at.getTime() + 30 * DAY));
    const end = new Date('2026-04-01T00:00:00Z');
    expect(creditExpiresAt({ credits: 1, expiresInDays: null, expiresAtPeriodEnd: true }, at, () => end)).toEqual(end);
    // A lifetime term has no end: "expire with the period" degrades to never rather than throwing.
    expect(creditExpiresAt({ credits: 1, expiresInDays: null, expiresAtPeriodEnd: true }, at, () => null)).toBeNull();
  });
  it('refuses an expiry outside the representable date range', () => {
    expect(() => creditExpiresAt({ credits: 1, expiresInDays: 100_000_000 }, at, () => null)).toThrow(TypeError);
  });
});

describe('paidPeriodEnd', () => {
  const start = new Date('2026-01-31T00:00:00Z');
  it('derives the end from the frozen plan snapshot', () => {
    expect(paidPeriodEnd({ plan: planSnapshot({ interval: 'one_time', termDays: 7 }) }, start)).toEqual(new Date(start.getTime() + 7 * DAY));
    expect(paidPeriodEnd({ plan: planSnapshot({ interval: 'lifetime', creditExpiry: null }) }, start)).toBeNull();
    const receipt = new Date('2026-03-01T00:00:00Z');
    expect(paidPeriodEnd({ plan: planSnapshot() }, start, receipt)).toEqual(receipt);
    expect(paidPeriodEnd({ plan: planSnapshot() }, start)).toEqual(new Date('2026-02-28T00:00:00Z')); // calendar month, clamped
    expect(paidPeriodEnd({ plan: planSnapshot({ interval: 'year' }) }, start)).toEqual(new Date('2027-01-31T00:00:00Z'));
  });
  it('fails closed on a missing or corrupt snapshot', () => {
    for (const bad of [null, undefined, {}, { plan: null }, { plan: planSnapshot({ amount: 9 }) }, { plan: planSnapshot({ creditExpiry: 'forever' }) }])
      expect(() => paidPeriodEnd(bad, start)).toThrow(/Plan snapshot/);
  });
});
