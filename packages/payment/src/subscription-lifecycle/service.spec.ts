import { describe, expect, it } from 'vitest';
import { SubscriptionCycleService } from './service';
import type { SubscriptionCycleInput, SubscriptionCyclePersistence, SubscriptionCycleReceipt, SubscriptionEntitlementBinding } from './types';
import type { SubscriptionPaidPeriod } from '../subscriptions/types';

const original: SubscriptionEntitlementBinding = {
  id: 'binding', ownerId: 'owner', providerId: 'synthetic', accountScope: 'test-merchant', subscriptionId: 'sub-1',
  catalogReference: 'monthly-price', money: { amount: '19.00', currency: 'USD' }, policyVersion: 'v1', policy: { credits: 100 }, grantBasis: 'period',
  initialOrderId: 'order-1', initialPaymentId: 'invoice-1', initialPaymentKind: 'invoice',
};
const input: SubscriptionCycleInput = { bindingId: 'binding', ownerId: 'owner', providerId: 'synthetic', accountScope: 'test-merchant',
  payment: { recordId: 'invoice-1', subscriptionId: 'sub-1', catalogReference: 'monthly-price',
    period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
    paidMoney: { amount: '19', currency: 'USD' }, paymentId: 'invoice-1', paymentKind: 'invoice', paidAt: '2026-10-01T00:01:00Z' } };

/** Transaction/lock contract fake only; the consumer's PostgreSQL adapter is separately exercised. */
function fixture() {
  const binding = structuredClone(original);
  let receipts = new Map<string, SubscriptionCycleReceipt>(), grants: SubscriptionCycleReceipt[] = [], fail = false;
  let tail = Promise.resolve();
  const persistence: SubscriptionCyclePersistence = { async transaction(_id, _owner, work) {
    const previous = tail; let release!: () => void; tail = new Promise<void>(done => { release = done; });
    await previous;
    const oldReceipts = structuredClone(receipts), oldGrants = structuredClone(grants);
    try { return await work({ binding,
      findCycle: async key => structuredClone(receipts.get(key) ?? null),
      findPayment: async search => structuredClone([...receipts.values()].find(row => row.providerId === search.providerId
        && row.accountScope === search.accountScope && row.paymentKind === search.paymentKind && row.paymentId === search.paymentId) ?? null),
      insertReceipt: async receipt => { if (receipts.has(receipt.cycleKey)) throw new Error('Duplicate receipt'); receipts.set(receipt.cycleKey, structuredClone(receipt)); },
      fulfill: async receipt => { grants.push(structuredClone(receipt)); if (fail) throw new Error('Synthetic ledger failure'); },
    }); } catch (error) { receipts = oldReceipts; grants = oldGrants; throw error; } finally { release(); }
  } };
  return { binding, service: new SubscriptionCycleService(persistence), persistence,
    receipts: () => [...receipts.values()], grants: () => grants, fail: (value: boolean) => { fail = value; } };
}

describe('subscription cycle entitlement coordination', () => {
  it('uses one receipt for concurrent initial checkout and renewal notifications', async () => {
    const f = fixture();
    const result = await Promise.all([f.service.apply(input), new SubscriptionCycleService(f.persistence).apply(input)]);
    expect(result.map(row => row.granted).sort()).toEqual([false, true]);
    expect(f.grants()).toHaveLength(1); expect(f.receipts()[0]).toMatchObject({ initial: true, policyVersion: 'v1', policy: { credits: 100 } });
  });
  it('keeps the same cycle identity across policy updates, event records and equivalent timezones', async () => {
    const f = fixture(); const first = await f.service.apply(input);
    f.binding.policyVersion = 'v2'; f.binding.policy = { credits: 500 }; f.binding.money = { amount: '99', currency: 'USD' };
    const replay = await f.service.apply({ ...input, payment: { ...input.payment, recordId: 'another-event-record',
      period: { start: '2026-10-01T08:00:00+08:00', end: '2026-11-01T08:00:00+08:00' } } });
    expect(replay.granted).toBe(false); expect(replay.receipt).toEqual(first.receipt); expect(f.grants()).toHaveLength(1);
  });
  it('fulfills a later cycle with a new receipt and preserves the earlier snapshot', async () => {
    const f = fixture(); await f.service.apply(input); f.binding.policyVersion = 'v2'; f.binding.policy = { credits: 200 };
    const result = await f.service.apply({ ...input, payment: { ...input.payment, recordId: 'invoice-2', paymentId: 'invoice-2',
      period: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' }, paidAt: '2026-11-01T00:01:00Z' } });
    expect(result.receipt).toMatchObject({ initial: false, policyVersion: 'v2', policy: { credits: 200 } });
    expect(f.receipts()[0].policy).toEqual({ credits: 100 }); expect(f.grants()).toHaveLength(2);
  });
  it('rolls back receipt and entitlement effects together and can safely recover', async () => {
    const f = fixture(); f.fail(true); await expect(f.service.apply(input)).rejects.toThrow('ledger failure');
    expect(f.receipts()).toEqual([]); expect(f.grants()).toEqual([]);
    f.fail(false); expect((await new SubscriptionCycleService(f.persistence).apply(input)).granted).toBe(true);
  });
  it('rejects one payment reused across periods and a changed payment on the same period', async () => {
    const f = fixture(); await f.service.apply(input);
    await expect(f.service.apply({ ...input, payment: { ...input.payment,
      period: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' } } })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.apply({ ...input, payment: { ...input.payment, paymentId: 'replacement-payment' } })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.grants()).toHaveLength(1);
  });
  it.each([{ ownerId: 'foreign' }, { providerId: 'foreign' }, { accountScope: 'another-merchant' }])('rejects foreign ownership/namespaces (%j)', async changed => {
    const f = fixture(); await expect(f.service.apply({ ...input, ...changed })).rejects.toThrow(); expect(f.grants()).toEqual([]);
  });
  it.each([
    { catalogReference: 'other-product' }, { subscriptionId: 'other-subscription' },
    { paidMoney: { amount: '0', currency: 'USD' } }, { paidMoney: { amount: '18.99', currency: 'USD' } },
    { paidMoney: { amount: '19', currency: 'EUR' } }, { paidAt: '2026-10-01 00:00:00' },
    { period: { start: '2026-10-01T00:00:00', end: '2026-11-01T00:00:00' } },
  ])('rejects unsupported or incomplete payment evidence (%j)', async changed => {
    const f = fixture(); await expect(f.service.apply({ ...input, payment: { ...input.payment, ...changed } })).rejects.toThrow();
    expect(f.receipts()).toEqual([]); expect(f.grants()).toEqual([]);
  });
  it('snapshots payment input before awaiting the transaction', async () => {
    const f = fixture(), mutable = structuredClone(input);
    const result = f.service.apply(mutable);
    mutable.ownerId = 'other'; mutable.payment.paidMoney.amount = '900';
    if ('period' in mutable.payment) mutable.payment.period.end = 'bad';
    expect((await result).receipt.paidMoney.amount).toBe('19');
  });
  it('supports an explicitly selected receipt policy without inventing calendar periods', async () => {
    const f = fixture(); f.binding.grantBasis = 'payment';
    const { period: _period, ...payment } = input.payment as SubscriptionPaidPeriod;
    const first = await f.service.apply({ ...input, payment });
    expect(first.receipt).toMatchObject({ basis: 'payment', periodStart: null, periodEnd: null, initial: true });
    expect((await f.service.apply({ ...input, payment })).granted).toBe(false);
    expect((await f.service.apply({ ...input, payment: { ...payment, paymentId: 'invoice-2', recordId: 'invoice-2' } })).granted).toBe(true);
    expect(f.grants()).toHaveLength(2);
  });
  it('does not fall back to receipt policy when a period-based subscription has no proof', async () => {
    const f = fixture();
    const { period: _period, ...payment } = input.payment as SubscriptionPaidPeriod;
    await expect(f.service.apply({ ...input, payment })).rejects.toThrow('period');
    expect(f.grants()).toEqual([]);
  });
});
