import { validateReferral } from '@zucker-framework/fe-site';
import type { CheckoutSelection } from './types';

export interface CheckoutAttempt extends CheckoutSelection { key: string; storageKey: string; orderId?: string }
const prefix = 'zucker.billing.checkout:';
const memory = new Map<string, CheckoutAttempt>();
const storage = () => { try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; } };

function persist(attempt: CheckoutAttempt): void {
  memory.set(attempt.storageKey, structuredClone(attempt));
  try { storage()?.setItem(attempt.storageKey, JSON.stringify(attempt)); } catch { /* Current-page retry still retains the same key. */ }
}

/** Retain one checkout identity per account/selection until paid or verified unpaid completion. */
export function checkoutAttempt(scope: string, selection: CheckoutSelection): CheckoutAttempt {
  // A different promo code is a different purchase (a new order with its own frozen price).
  const promoCode = selection.promoCode ? selection.promoCode.toUpperCase() : '';
  const storageKey = prefix + JSON.stringify([scope, selection.offerId, selection.providerId, ...(promoCode ? [promoCode] : [])]);
  const retained = memory.get(storageKey);
  if (retained) return structuredClone(retained);
  try {
    const saved = JSON.parse(storage()?.getItem(storageKey) ?? 'null') as Partial<CheckoutAttempt> | null;
    if (saved && typeof saved.key === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(saved.key)
      && saved.offerId === selection.offerId && saved.providerId === selection.providerId) {
      const referral = validateReferral(saved.referral, { enabledProviders: ['affonso', 'promotekit'] });
      const attempt: CheckoutAttempt = { storageKey, key: saved.key, offerId: selection.offerId, providerId: selection.providerId,
        ...(referral ? { referral } : {}), ...(promoCode ? { promoCode } : {}),
        ...(typeof saved.orderId === 'string' ? { orderId: saved.orderId } : {}) };
      persist(attempt); return structuredClone(attempt);
    }
  } catch { /* Malformed or inaccessible session storage never supplies a purchase identity. */ }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const attempt: CheckoutAttempt = { ...structuredClone(selection), ...(promoCode ? { promoCode } : {}), storageKey, key };
  persist(attempt); return structuredClone(attempt);
}
export function rememberCheckoutOrder(attempt: CheckoutAttempt, orderId: string): void {
  persist({ ...attempt, orderId });
}
export function completeCheckoutAttempt(orderId: string): void {
  const keys = new Set(memory.keys());
  const session = storage();
  try { for (let index = 0; session && index < session.length; index++) { const key = session.key(index); if (key?.startsWith(prefix)) keys.add(key); } } catch { /* Memory is sufficient for this document. */ }
  for (const key of keys) {
    try {
      const attempt = memory.get(key) ?? JSON.parse(session?.getItem(key) ?? 'null') as CheckoutAttempt | null;
      if (attempt?.orderId !== orderId) continue;
      memory.delete(key); session?.removeItem(key);
    } catch { /* Ignore another malformed or inaccessible browser record. */ }
  }
}
