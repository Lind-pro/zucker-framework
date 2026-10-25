import type { Money } from '../contract/payment-contract';
import { HostedCheckoutError, type HostedCheckoutOffer } from './types';

export function nonempty(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HostedCheckoutError('invalid_input', `${label} is required`);
  return value;
}

export function canonicalMoney(money: Money): string {
  if (!money || typeof money.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(money.amount) ||
      typeof money.currency !== 'string' || !/^[A-Z]{3}$/.test(money.currency)) {
    throw new HostedCheckoutError('verification_failed', 'Invalid exact money');
  }
  const [whole, fraction = ''] = money.amount.split('.');
  const decimals = fraction.replace(/0+$/, '');
  return `${money.currency}:${whole.replace(/^0+(?=\d)/, '')}${decimals ? `.${decimals}` : ''}`;
}

export function checkoutUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.href;
  } catch { throw new HostedCheckoutError('verification_failed', 'Checkout URL must use HTTP(S) without credentials'); }
}

/** Preserve JSON values exactly: do not silently stringify dates, drop undefined or coerce NaN. */
export function snapshotFulfillmentData(value: unknown): HostedCheckoutOffer['fulfillmentData'] {
  if (value === undefined) return undefined;
  const invalid = () => { throw new HostedCheckoutError('invalid_input', 'Fulfillment data must be a finite, acyclic plain JSON record'); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return; }
    if (typeof item !== 'object' || depth > 64) return invalid();
    if (ancestors.has(item)) return invalid();
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return invalid();
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return invalid();
      if (array && key === 'length') continue;
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) return invalid();
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
      visit(descriptor.value, depth + 1);
    }
    if (array && Object.keys(descriptors).length !== item.length + 1) return invalid();
    ancestors.delete(item);
  }
  visit(value, 0);
  return structuredClone(value) as HostedCheckoutOffer['fulfillmentData'];
}

const reservedMetadataKeys = new Set(['reference', 'referenceid', 'reference_id', 'client_reference_id',
  'requestid', 'request_id', 'order', 'orderid', 'order_id', 'offer', 'offerid', 'offer_id',
  'offerversion', 'offer_version', 'ownerid', 'owner_id', 'userid', 'user_id', '__proto__', 'prototype', 'constructor']);

/** Stripe-compatible bounds; the consumer still owns which public fields are allowed at all. */
export function snapshotProviderMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const invalid = () => { throw new HostedCheckoutError('invalid_input', 'Provider metadata requires at most 50 public string fields, safe keys up to 40 characters and values up to 500 characters; correlation keys are reserved'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 50) return invalid();
  const entries: Array<[string, string]> = [];
  for (const key of keys) {
    if (typeof key !== 'string' || key.length < 1 || key.length > 40 || /[^a-zA-Z0-9_-]/.test(key) || reservedMetadataKeys.has(key.toLowerCase())) return invalid();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !('value' in property) || typeof property.value !== 'string' ||
        property.value.length > 500 || /[\u0000-\u001f\u007f]/.test(property.value)) return invalid();
    entries.push([key, property.value]);
  }
  return entries.length ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
