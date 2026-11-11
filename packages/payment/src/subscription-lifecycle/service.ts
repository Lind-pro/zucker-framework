import { createHash } from 'node:crypto';
import { subscriptionPeriodKey } from '../contract/subscription-observation';
import { HostedCheckoutError } from '../hosted-checkout/types';
import { canonicalMoney, nonempty, snapshotFulfillmentData } from '../hosted-checkout/validation';
import type { SubscriptionCycleInput, SubscriptionCyclePersistence, SubscriptionCycleReceipt } from './types';

/** Provider reads happen before this service. Initial and later periods share the same durable identity. */
export class SubscriptionCycleService {
  constructor(private readonly persistence: SubscriptionCyclePersistence, private readonly now: () => Date = () => new Date()) {
    if (!persistence?.transaction) throw new HostedCheckoutError('invalid_input', 'Transactional cycle persistence is required');
  }

  async apply(input: SubscriptionCycleInput): Promise<{ receipt: SubscriptionCycleReceipt; granted: boolean }> {
    // Snapshot all incoming facts before awaiting a lock or persistence operation.
    const selection = { bindingId: input.bindingId, ownerId: input.ownerId, providerId: input.providerId,
      accountScope: input.accountScope, payment: structuredClone(input.payment) };
    for (const field of ['bindingId', 'ownerId', 'providerId', 'accountScope'] as const) nonempty(selection[field], field);
    const payment = selection.payment;
    for (const value of [payment.recordId, payment.subscriptionId, payment.catalogReference, payment.paymentId]) nonempty(value, 'Paid period identity');
    if (!['invoice', 'transaction', 'capture', 'payment-intent'].includes(payment.paymentKind))
      throw new HostedCheckoutError('verification_failed', 'Payment reference kind is unsupported');
    const paid = canonicalMoney(payment.paidMoney);
    if (paid.endsWith(':0')) throw new HostedCheckoutError('verification_failed', 'A paid cycle requires positive actual money');
    if (typeof payment.paidAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(payment.paidAt)
      || !Number.isFinite(Date.parse(payment.paidAt))) throw new HostedCheckoutError('verification_failed', 'Paid cycle timestamp is missing or invalid');
    return this.persistence.transaction(selection.bindingId, selection.ownerId, async transaction => {
      const binding = structuredClone(transaction.binding);
      if (binding.id !== selection.bindingId || binding.ownerId !== selection.ownerId)
        throw new HostedCheckoutError('forbidden', 'Subscription owner mismatch');
      if (binding.providerId !== selection.providerId || binding.accountScope !== selection.accountScope
        || binding.subscriptionId !== payment.subscriptionId || binding.catalogReference !== payment.catalogReference)
        throw new HostedCheckoutError('verification_failed', 'Subscription payment identity mismatch');
      if (binding.grantBasis !== 'period' && binding.grantBasis !== 'payment')
        throw new HostedCheckoutError('invalid_input', 'An explicit subscription grant basis is required');
      const period = 'period' in payment ? payment.period : undefined;
      let cycleKey: string;
      let periodStart: Date | null = null, periodEnd: Date | null = null;
      try {
        if (binding.grantBasis === 'period') {
          if (!period) throw new Error('Missing period');
          cycleKey = subscriptionPeriodKey({ provider: selection.providerId, accountScope: selection.accountScope,
            subscriptionId: payment.subscriptionId, period });
          periodStart = new Date(period.start); periodEnd = new Date(period.end);
        } else cycleKey = JSON.stringify(['receipt', selection.providerId, selection.accountScope, payment.subscriptionId, payment.paymentKind, payment.paymentId]);
      }
      catch { throw new HostedCheckoutError('verification_failed', 'Paid cycle period is missing or invalid'); }
      // Existing periods retain their original policy version even if the consumer changes a later-period policy.
      const existing = await transaction.findCycle(cycleKey);
      if (existing) {
        if (existing.cycleKey !== cycleKey || existing.bindingId !== binding.id || existing.ownerId !== binding.ownerId
          || existing.paymentId !== payment.paymentId || existing.paymentKind !== payment.paymentKind
          || canonicalMoney(existing.paidMoney) !== paid || !Number.isFinite(existing.fulfilledAt.getTime()))
          throw new HostedCheckoutError('conflict', 'Subscription cycle evidence changed');
        return { receipt: existing, granted: false };
      }
      const initial = payment.paymentId === binding.initialPaymentId && payment.paymentKind === binding.initialPaymentKind;
      // Only the initial payment may carry a frozen first-invoice discount; renewals pay the list price.
      if (canonicalMoney(initial && binding.initialMoney ? binding.initialMoney : binding.money) !== paid)
        throw new HostedCheckoutError('verification_failed', 'Paid cycle amount differs from the frozen offer');
      const claimed = await transaction.findPayment({ providerId: selection.providerId, accountScope: selection.accountScope,
        paymentKind: payment.paymentKind, paymentId: payment.paymentId });
      if (claimed) throw new HostedCheckoutError('conflict', 'Payment already belongs to another subscription cycle');
      const policy = snapshotFulfillmentData(binding.policy);
      if (!policy) throw new HostedCheckoutError('invalid_input', 'Subscription entitlement policy is required');
      nonempty(binding.policyVersion, 'Policy version');
      const receipt: SubscriptionCycleReceipt = {
        id: createHash('sha256').update(cycleKey).digest('hex'), cycleKey, bindingId: binding.id,
        ownerId: binding.ownerId, providerId: binding.providerId, accountScope: binding.accountScope,
        subscriptionId: binding.subscriptionId, catalogReference: binding.catalogReference,
        basis: binding.grantBasis,
        periodStart, periodEnd,
        paymentId: payment.paymentId, paymentKind: payment.paymentKind, recordId: payment.recordId,
        paidMoney: structuredClone(payment.paidMoney), paidAt: new Date(payment.paidAt),
        policyVersion: binding.policyVersion, policy, initial,
        fulfilledAt: this.now(),
      };
      await transaction.insertReceipt(structuredClone(receipt));
      await transaction.fulfill(structuredClone(receipt));
      return { receipt, granted: true };
    });
  }
}
