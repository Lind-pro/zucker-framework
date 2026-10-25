import { subscriptionPeriodKey, type SubscriptionPeriod } from '../contract/subscription-observation';
import { canonicalMoney } from '../hosted-checkout/validation';
import type { Money } from '../contract/payment-contract';
import { SubscriptionProtocolError } from './types';

export function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new SubscriptionProtocolError('invalid_input', 'Subscription resource identity is required');
  }
  return value;
}
export function sameId(actual: unknown, expected: string): void {
  if (actual !== expected) throw new SubscriptionProtocolError('verification_failed', 'Provider returned a different resource');
}
export function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}
export function secondsDate(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value * 1000).getTime())
    ? new Date(value * 1000).toISOString() : undefined;
}
export function validPeriod(start: unknown, end: unknown): SubscriptionPeriod | undefined {
  const a = isoDate(start), b = isoDate(end);
  if (!a || !b || a >= b) return undefined;
  return { start: a, end: b };
}
export function assertPeriod(period: SubscriptionPeriod): SubscriptionPeriod {
  try { subscriptionPeriodKey({ provider: 'proof', accountScope: 'proof', subscriptionId: 'proof', period }); }
  catch { throw new SubscriptionProtocolError('invalid_response', 'Invalid subscription period evidence'); }
  return { start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString() };
}
export function validMoney(money: Money): Money {
  canonicalMoney(money);
  return money;
}
export function secureUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new SubscriptionProtocolError('invalid_response', 'Provider URL must use HTTPS without credentials'); }
}
export function encodeCursor(value: Record<string, unknown>): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
export function decodeCursor(value: string): Record<string, unknown> {
  try {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    return decoded as Record<string, unknown>;
  } catch { throw new SubscriptionProtocolError('invalid_input', 'Invalid subscription page cursor'); }
}
