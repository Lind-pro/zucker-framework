import { describe, expect, it } from 'vitest';
import {
  SubscriptionAssignmentError, SubscriptionAssignmentService,
  type SubscriptionPaymentApplication, type SubscriptionPaymentEvidence, type UserSubscriptionRecord, type UserSubscriptionStore,
} from '../index';

/** Minimal in-memory store: one term per user, a payment ledger by reference. */
function fixture(start = '2026-06-01T00:00:00Z') {
  const clock = { now: new Date(start) };
  const rows = new Map<string, UserSubscriptionRecord>();
  const evidence = new Map<string, SubscriptionPaymentEvidence>();
  const applications = new Map<string, SubscriptionPaymentApplication>();
  const refunds = new Set<string>();
  const store: UserSubscriptionStore<'tx'> = {
    async transaction(_userId, work) { return work('tx'); },
    async userAssignable() { return true; },
    async find(_tx, id) { return rows.get(id) ?? null; },
    async findPlanBySlug(_tx, slug) { return { id: `p-${slug}`, slug, status: true }; },
    async findPlanById(_tx, id) { return { id, slug: id.replace(/^p-/, ''), status: true }; },
    async pendingPayment() { return null; },
    async recordPaymentEvidence(_tx, item) { if (evidence.has(item.reference)) return false; evidence.set(item.reference, item); return true; },
    async findPaymentEvidence(_tx, reference) { return evidence.get(reference) ?? null; },
    paymentHistory: {
      async recordApplication(_tx, application) { applications.set(application.evidence.reference, application); },
      async findApplication(_tx, reference) { return applications.get(reference) ?? null; },
      async recordRefund(_tx, reference) { if (refunds.has(reference)) return false; refunds.add(reference); return true; },
      async isRefunded(_tx, reference) { return refunds.has(reference); },
    },
    async save(_tx, userId, data) {
      const prior = rows.get(userId);
      const row = { ...data, id: prior?.id ?? `sub-${userId}`, userId, createdAt: prior?.createdAt ?? clock.now, updatedAt: clock.now };
      rows.set(userId, row); return row;
    },
  };
  const service = new SubscriptionAssignmentService(store, {
    now: () => clock.now,
    activeTerm: (term, at) => (term.status === 'ACTIVE' || term.status === 'CANCELED') && !!term.startDate && term.startDate <= at
      && (term.endDate ? term.endDate > at : term.billingCycle === 'LIFETIME'),
  });
  const D = (iso: string) => new Date(iso);
  return { service, store, clock, rows, evidence, applications, refunds, D };
}

describe('SubscriptionAssignmentService.revokePayment', () => {
  it('revokes a one-time term defined by the refunded payment and keeps the evidence (no re-apply)', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:o1',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z'), orderId: 'o1' });
    f.clock.now = f.D('2026-06-10T00:00:00Z');
    const result = await f.service.revokePayment({ userId: 'u', reference: 'order:o1' });
    expect(result.outcome).toBe('revoked');
    expect(result.change).toMatchObject({ kind: 'refunded', userId: 'u' });
    expect(result.subscription).toMatchObject({ status: 'EXPIRED', endDate: f.clock.now, cancelAtPeriodEnd: false, canceledAt: f.clock.now });
    // Evidence stays, so the same reference can never grant the term again.
    expect(f.evidence.has('order:o1')).toBe(true);
    const replay = await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:o1',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z') });
    expect(replay.outcome).toBe('replayed');
    // A second revoke finds no live term.
    expect((await f.service.revokePayment({ userId: 'u', reference: 'order:o1' })).outcome).toBe('inactive');
  });

  it('shortens a stacked one-time term by exactly the refunded duration', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:a',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z') });
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:b',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z') });
    const stacked = f.rows.get('u')!;
    expect(stacked.paymentReference).toBe('order:b');
    expect(stacked.endDate).toEqual(f.D('2026-07-31T00:00:00Z'));
    const result = await f.service.revokePayment({ userId: 'u', reference: 'order:b' });
    expect(result.outcome).toBe('shortened');
    expect(result.subscription?.endDate).toEqual(f.D('2026-07-01T00:00:00Z'));
    expect(result.subscription?.status).toBe('ACTIVE');
  });

  it('falls a recurring term back to the start of the refunded period, or revokes when that is past', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'MONTHLY', reference: 'cycle:1',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z') });
    f.clock.now = f.D('2026-06-20T00:00:00Z');
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'MONTHLY', reference: 'cycle:2',
      periodStart: f.D('2026-07-01T00:00:00Z'), periodEnd: f.D('2026-08-01T00:00:00Z') });
    expect(f.rows.get('u')!.endDate).toEqual(f.D('2026-08-01T00:00:00Z'));
    // Refunding the pre-paid next period leaves the earlier paid period.
    const shortened = await f.service.revokePayment({ userId: 'u', reference: 'cycle:2' });
    expect(shortened).toMatchObject({ outcome: 'shortened', subscription: { endDate: f.D('2026-07-01T00:00:00Z'), status: 'ACTIVE' } });
    // After the first period's start moved into the past, its refund revokes (start is not in the future).
    expect(shortened.subscription?.paymentReference).toBe('cycle:1');
    const revoked = await f.service.revokePayment({ userId: 'u', reference: 'cycle:1' });
    expect(revoked.outcome).toBe('revoked');
    expect(revoked.subscription).toMatchObject({ status: 'EXPIRED', endDate: f.clock.now });
  });

  it('revokes a lifetime term and keeps endDate null', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'LIFETIME', reference: 'order:life',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: null });
    const result = await f.service.revokePayment({ userId: 'u', reference: 'order:life' });
    expect(result.outcome).toBe('revoked');
    expect(result.subscription).toMatchObject({ status: 'EXPIRED', endDate: null });
  });

  it('removes earlier stacked evidence without affecting later ownership', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:old',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z') });
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:new',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z') });
    const notCurrent = await f.service.revokePayment({ userId: 'u', reference: 'order:old' });
    expect(notCurrent).toMatchObject({ outcome: 'shortened', subscription: { paymentReference: 'order:new', endDate: f.D('2026-07-01T00:00:00Z') } });
    expect((await f.service.revokePayment({ userId: 'u', reference: 'order:missing' })).outcome).toBe('not_found');
    // Another user's reference is never revoked through this user.
    expect((await f.service.revokePayment({ userId: 'other', reference: 'order:new' })).outcome).toBe('not_found');
    expect(f.rows.get('u')).toEqual(notCurrent.subscription);
  });

  it('reports inactive for an expired term and not_current for a different plan', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:x',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-06-15T00:00:00Z') });
    f.clock.now = f.D('2026-07-01T00:00:00Z');
    expect(await f.service.revokePayment({ userId: 'u', reference: 'order:x' })).toMatchObject({ outcome: 'inactive', change: null });
    // Plan changed by an administrator after the payment.
    const g = fixture();
    await g.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:y',
      periodStart: g.D('2026-06-01T00:00:00Z'), periodEnd: g.D('2026-07-01T00:00:00Z') });
    await g.service.assign('u', { planSlug: 'basic', billingCycle: 'MONTHLY' });
    expect((await g.service.revokePayment({ userId: 'u', reference: 'order:y' })).outcome).toBe('not_current');
  });

  it.each([['a', 'b'], ['b', 'a']])('removes both stacked grants in refund order %s then %s, with replay', async (first, second) => {
    const f = fixture();
    for (const reference of ['a', 'b']) await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference,
      periodStart: f.clock.now, periodEnd: f.D('2026-07-01T00:00:00Z') });
    const firstResult = await f.service.revokePayment({ userId: 'u', reference: first });
    expect(firstResult.subscription?.endDate).toEqual(f.D('2026-07-01T00:00:00Z'));
    expect(firstResult.subscription?.paymentReference).toBe(second);
    expect((await f.service.revokePayment({ userId: 'u', reference: first })).change).toBeNull();
    expect((await f.service.revokePayment({ userId: 'u', reference: second })).subscription?.status).toBe('EXPIRED');
  });

  it('keeps only the surviving purchase period when an older stacked purchase is refunded later', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'a',
      periodStart: f.clock.now, periodEnd: f.D('2026-07-01T00:00:00Z') });
    f.clock.now = f.D('2026-06-10T00:00:00Z');
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'b',
      periodStart: f.clock.now, periodEnd: f.D('2026-07-10T00:00:00Z') });
    const result = await f.service.revokePayment({ userId: 'u', reference: 'a' });
    expect(result.subscription).toMatchObject({ startDate: f.D('2026-06-10T00:00:00Z'), endDate: f.D('2026-07-10T00:00:00Z') });
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'c',
      periodStart: f.clock.now, periodEnd: f.D('2026-07-10T00:00:00Z') });
    await f.service.revokePayment({ userId: 'u', reference: 'b' });
    expect(f.rows.get('u')?.endDate).toEqual(f.D('2026-07-10T00:00:00Z'));
    expect((await f.service.revokePayment({ userId: 'u', reference: 'c' })).subscription?.status).toBe('EXPIRED');
  });

  it('restores an administrator baseline and preserves a later cancellation', async () => {
    const f = fixture();
    const admin = await f.service.assign('u', { planSlug: 'pro', billingCycle: 'ONE_TIME', endDate: '2026-06-20T00:00:00Z' });
    for (const reference of ['a', 'b']) await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference,
      periodStart: f.clock.now, periodEnd: f.D('2026-07-01T00:00:00Z') });
    await f.service.cancel('u');
    await f.service.revokePayment({ userId: 'u', reference: 'a' });
    const restored = await f.service.revokePayment({ userId: 'u', reference: 'b' });
    expect(restored.subscription).toMatchObject({ source: 'admin', paymentReference: null, endDate: admin.endDate, status: 'CANCELED' });
  });

  it('restores the previous plan after a lifetime upgrade refund, excluding earlier refunded payments', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'a',
      periodStart: f.clock.now, periodEnd: f.D('2026-07-01T00:00:00Z') });
    await f.service.recordPayment({ userId: 'u', planId: 'p-premium', billingCycle: 'LIFETIME', reference: 'b', periodStart: f.clock.now, periodEnd: null });
    expect((await f.service.revokePayment({ userId: 'u', reference: 'b' })).subscription).toMatchObject({ planId: 'p-pro', paymentReference: 'a' });
    await f.service.revokePayment({ userId: 'u', reference: 'a' });
    expect(f.rows.get('u')?.status).toBe('EXPIRED');
  });

  it('does not resurrect an older plan that was refunded while another plan controlled the term', async () => {
    const f = fixture();
    for (const [reference, planId] of [['a', 'p-pro'], ['b', 'p-premium']]) await f.service.recordPayment({ userId: 'u', planId, billingCycle: 'MONTHLY', reference,
      periodStart: f.clock.now, periodEnd: f.D('2026-07-01T00:00:00Z') });
    expect((await f.service.revokePayment({ userId: 'u', reference: 'a' })).change).toBeNull();
    expect((await f.service.revokePayment({ userId: 'u', reference: 'b' })).subscription?.status).toBe('EXPIRED');
  });

  it('revokes the remaining future recurring grant before its period starts', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'MONTHLY', reference: 'a',
      periodStart: f.clock.now, periodEnd: f.D('2026-07-01T00:00:00Z') });
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'MONTHLY', reference: 'b',
      periodStart: f.D('2026-07-01T00:00:00Z'), periodEnd: f.D('2026-08-01T00:00:00Z') });
    const first = await f.service.revokePayment({ userId: 'u', reference: 'a' });
    expect(first.subscription?.startDate).toEqual(f.D('2026-07-01T00:00:00Z'));
    expect((await f.service.revokePayment({ userId: 'u', reference: 'b' })).subscription?.status).toBe('EXPIRED');
  });

  it('fails closed for a legacy store without durable history', async () => {
    const f = fixture();
    f.store.paymentHistory = undefined;
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'MONTHLY', reference: 'old',
      periodStart: f.clock.now, periodEnd: f.D('2026-07-01T00:00:00Z') });
    await expect(f.service.revokePayment({ userId: 'u', reference: 'old' })).rejects.toMatchObject({ reason: 'unavailable' });
    expect(f.rows.get('u')?.status).toBe('ACTIVE');
  });

  it('validates identifiers', async () => {
    const f = fixture();
    await expect(f.service.revokePayment({ userId: '', reference: 'r' })).rejects.toBeInstanceOf(SubscriptionAssignmentError);
    await expect(f.service.revokePayment({ userId: 'u', reference: '' })).rejects.toMatchObject({ reason: 'invalid' });
  });
});
