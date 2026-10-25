import type { ReferralProvider, SiteReferral } from '@zucker-framework/fe-site';

export interface BillingMoney { amount: string; currency: string }
export interface BillingProvider { id: string; requiresCapture: boolean; referralProviders: ReferralProvider[]; grantBasis?: 'period' | 'payment' }
export interface BillingOffer {
  id: string; title: string; mode: 'payment' | 'subscription'; money: BillingMoney;
  credits: number; expiresInDays: number | null; providers: BillingProvider[];
}
export interface CheckoutOrder {
  id: string; offerId: string; providerId: string; title: string; mode: 'payment' | 'subscription'; money: BillingMoney;
  state: 'unknown' | 'pending' | 'requires_capture' | 'paid' | 'unpaid';
  creationState: 'prepared' | 'submitting' | 'created'; captureState: 'idle' | 'submitting' | 'confirmed';
  checkoutUrl: string | null; fulfilledAt: string | null; createdAt: string; subscriptionId: string | null;
  refund?: { state: 'none' | 'pending' | 'partial' | 'full'; refundedMoney: BillingMoney; pendingMoney: BillingMoney | null;
    suppressedCredits: number; recoveredCredits: number; needsAttention: boolean } | null;
}
export interface CheckoutOrderPage { data: CheckoutOrder[]; total: number; page: number; pageSize: number }
export interface CheckoutSelection { offerId: string; providerId: string; referral?: SiteReferral }

export function orderStatus(order: CheckoutOrder) {
  if (order.refund?.state === 'full') return 'refunded' as const;
  if (order.refund?.state === 'partial') return 'partiallyRefunded' as const;
  if (order.refund?.state === 'pending') return 'refundPending' as const;
  if (order.state === 'paid' && order.fulfilledAt) return 'paid' as const;
  if (order.state === 'paid') return 'processing' as const;
  if (order.captureState === 'submitting') return 'confirming' as const;
  if (order.creationState !== 'created') return 'preparing' as const;
  if (order.state === 'requires_capture' && order.captureState === 'idle') return 'requiresCapture' as const;
  return order.state === 'unpaid' ? 'unpaid' as const : 'pending' as const;
}

export type SubscriptionCancelMode = 'immediate' | 'period_end';
export interface BillingSubscription {
  id: string; title: string; providerId: string;
  status: 'active' | 'trialing' | 'past_due' | 'unpaid' | 'paused' | 'canceled' | 'unknown';
  grantBasis: 'period' | 'payment'; money: BillingMoney;
  currentPeriod: { start: string; end: string } | null;
  cancelAtPeriodEnd: boolean | null; canceledAt: string | null;
  cancelState: 'idle' | 'submitting' | 'confirmed'; cancelMode: SubscriptionCancelMode | null;
  initialFulfilledAt: string | null; observedAt: string | null; createdAt: string;
  reconcileStatus?: 'pending' | 'idle' | 'attention';
  capabilities: { refresh: boolean; cancel: SubscriptionCancelMode[]; billingPortal: boolean; invoices: boolean;
    paidPeriodProof: 'provider' | 'merchant_receipt' | 'unavailable'; paidReceiptProof: 'provider' | 'unavailable' };
}
export interface SubscriptionPage { data: BillingSubscription[]; total: number; page: number; pageSize: number }
export interface SubscriptionReceipt {
  id: string; paidMoney: BillingMoney; paidAt: string; period: { start: string; end: string } | null; initial: boolean; url: string | null;
}
export interface SubscriptionReceiptPage { data: SubscriptionReceipt[]; total: number; page: number; pageSize: number }
export function subscriptionStatus(subscription: BillingSubscription) {
  if (subscription.cancelState === 'submitting') return 'cancelPending' as const;
  if (subscription.status === 'canceled') return 'canceled' as const;
  if (subscription.cancelAtPeriodEnd) return 'ending' as const;
  return subscription.status;
}
export function safeBillingUrl(value: string | null): string | null {
  const url = safeCheckoutUrl(value);
  return url?.startsWith('https:') ? url : null;
}
export function moneyLabel(money: BillingMoney): string {
  // Preserve the server's exact decimal string; display formatting never changes the purchase amount.
  return `${money.currency} ${money.amount}`;
}
export function providerLabel(id: string): string {
  return ({ stripe: 'Stripe', paypal: 'PayPal', creem: 'Creem' } as Record<string, string>)[id] ?? id;
}
export function safeCheckoutUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function billingErrorKey(error: unknown, fallback: string): string {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 403) return 'accessDenied';
  if (status === 404) return 'orderNotFound';
  if (status === 429) return 'tooManyRequests';
  return fallback;
}
