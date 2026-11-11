import { describe, expect, it } from 'vitest';
import {
  SubscriptionAssignmentError, SubscriptionAssignmentService,
  type SubscriptionPaymentEvidence, type UserSubscriptionRecord, type UserSubscriptionStore,
} from '../index';

/** Minimal in-memory store: one term per user, a payment ledger by reference. */
function fixture(start = '2026-06-01T00:00:00Z') {
  const clock = { now: new Date(start) };
  const rows = new Map<string, UserSubscriptionRecord>();
  const evidence = new Map<string, SubscriptionPaymentEvidence>();
  const store: UserSubscriptionStore<'tx'> = {
    async transaction(_userId, work) { return work('tx'); },
    async userAssignable() { return true; },
    async find(_tx, id) { return rows.get(id) ?? null; },
    async findPlanBySlug(_tx, slug) { return { id: `p-${slug}`, slug, status: true }; },
    async findPlanById(_tx, id) { return { id, slug: id.replace(/^p-/, ''), status: true }; },
    async pendingPayment() { return null; },
    async recordPaymentEvidence(_tx, item) { if (evidence.has(item.reference)) return false; evidence.set(item.reference, item); return true; },
    async findPaymentEvidence(_tx, reference) { return evidence.get(reference) ?? null; },
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
  return { service, clock, rows, evidence, D };
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
    f.rows.set('u', { ...f.rows.get('u')!, paymentReference: 'cycle:1' });
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

  it('leaves the term alone when other evidence defines it, or the user owns no such payment', async () => {
    const f = fixture();
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:old',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z') });
    await f.service.recordPayment({ userId: 'u', planId: 'p-pro', billingCycle: 'ONE_TIME', reference: 'order:new',
      periodStart: f.D('2026-06-01T00:00:00Z'), periodEnd: f.D('2026-07-01T00:00:00Z') });
    const before = { ...f.rows.get('u')! };
    const notCurrent = await f.service.revokePayment({ userId: 'u', reference: 'order:old' });
    expect(notCurrent).toMatchObject({ outcome: 'not_current', change: null });
    expect(f.rows.get('u')).toEqual(before);
    expect((await f.service.revokePayment({ userId: 'u', reference: 'order:missing' })).outcome).toBe('not_found');
    // Another user's reference is never revoked through this user.
    expect((await f.service.revokePayment({ userId: 'other', reference: 'order:new' })).outcome).toBe('not_found');
    expect(f.rows.get('u')).toEqual(before);
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
    g.rows.set('u', { ...g.rows.get('u')!, planId: 'p-basic' });
    expect((await g.service.revokePayment({ userId: 'u', reference: 'order:y' })).outcome).toBe('not_current');
  });

  it('validates identifiers', async () => {
    const f = fixture();
    await expect(f.service.revokePayment({ userId: '', reference: 'r' })).rejects.toBeInstanceOf(SubscriptionAssignmentError);
    await expect(f.service.revokePayment({ userId: 'u', reference: '' })).rejects.toMatchObject({ reason: 'invalid' });
  });
});
