import { accountPublicClient, httpClient } from '@/lib/http-client';
import type { BillingSubscription, CheckoutOrder, CheckoutOrderPage, CheckoutSelection, SubscriptionCancelMode, SubscriptionPage, SubscriptionReceiptPage } from './types';

export const billingApi = {
  /** Anonymous `GET /billing/plans`; parse with parsePricingCatalog. */
  plans: (locale: string) => accountPublicClient.get<unknown>('/billing/plans', { locale }),
  identity: () => httpClient.get<{ id: string }>('/authorize/me'),
  orders: (page: number) => httpClient.get<CheckoutOrderPage>('/billing/orders', { page }),
  order: (id: string) => httpClient.get<CheckoutOrder>(`/billing/orders/${encodeURIComponent(id)}`),
  create: (selection: CheckoutSelection, key: string) => httpClient.post<CheckoutOrder>('/billing/orders', {
    offerId: selection.offerId, providerId: selection.providerId,
    ...(selection.referral ? { referral: selection.referral } : {}),
  }, undefined, { headers: { 'Idempotency-Key': key } }),
  confirm: (id: string, checkoutId?: string) => httpClient.post<CheckoutOrder>(`/billing/orders/${encodeURIComponent(id)}/confirm`, checkoutId ? { checkoutId } : {}),
  capture: (id: string) => httpClient.post<CheckoutOrder>(`/billing/orders/${encodeURIComponent(id)}/capture`, { approved: true }),
  subscriptions: (page: number) => httpClient.get<SubscriptionPage>('/billing/subscriptions', { page }),
  subscription: (id: string) => httpClient.get<BillingSubscription>(`/billing/subscriptions/${encodeURIComponent(id)}`),
  refreshSubscription: (id: string) => httpClient.post<BillingSubscription>(`/billing/subscriptions/${encodeURIComponent(id)}/refresh`, {}),
  cancelSubscription: (id: string, mode: SubscriptionCancelMode) => httpClient.post<BillingSubscription>(`/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { mode }),
  subscriptionReceipts: (id: string, page: number) => httpClient.get<SubscriptionReceiptPage>(`/billing/subscriptions/${encodeURIComponent(id)}/invoices`, { page }),
  subscriptionPortal: (id: string) => httpClient.post<{ url: string }>(`/billing/subscriptions/${encodeURIComponent(id)}/portal`, {}),
};
