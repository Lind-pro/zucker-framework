import type { Money } from '../contract/payment-contract';
import { canonicalMoney } from '../hosted-checkout/validation';
import { RefundProtocolError, type RefundCommand, type RefundPaymentReference } from './types';

export function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value)) throw new RefundProtocolError('invalid_input', 'Refund resource identity is required', 'rejected');
  return value;
}
export function exactMoney(value: Money, positive = false): Money {
  try {
    if (value.amount.length > 96 || canonicalMoney(value).endsWith(':0') && positive) throw new Error();
    canonicalMoney(value); return value;
  } catch { throw new RefundProtocolError('invalid_input', 'Refund money must be exact and nonnegative', 'rejected'); }
}
function units(a: Money, b: Money) {
  exactMoney(a); exactMoney(b);
  if (a.currency !== b.currency) throw new RefundProtocolError('verification_failed', 'Refund currency differs from the payment');
  const first = a.amount.split('.'), second = b.amount.split('.');
  const scale = Math.max(first[1]?.length ?? 0, second[1]?.length ?? 0);
  return { first: BigInt(first[0] + (first[1] ?? '').padEnd(scale, '0')),
    second: BigInt(second[0] + (second[1] ?? '').padEnd(scale, '0')), scale };
}
export function sameMoney(a: Money, b: Money): void {
  if (compareMoney(a, b) !== 0) throw new RefundProtocolError('verification_failed', 'Refund payment amount differs from the bound evidence');
}
export function compareMoney(a: Money, b: Money): number {
  const values = units(a, b); return values.first < values.second ? -1 : values.first > values.second ? 1 : 0;
}
export function subtractMoney(a: Money, b: Money): Money {
  const values = units(a, b), difference = values.first - values.second;
  if (difference < 0n) throw new RefundProtocolError('invalid_response', 'Refund aggregate exceeds the actual paid amount');
  const digits = difference.toString().padStart(values.scale + 1, '0');
  return { currency: a.currency, amount: values.scale ? `${digits.slice(0, -values.scale)}.${digits.slice(-values.scale)}` : digits };
}
export function validatePayment(payment: RefundPaymentReference, kinds: readonly string[]): void {
  identity(payment.paymentId); exactMoney(payment.paidMoney, true);
  if (!kinds.includes(payment.paymentKind)) throw new RefundProtocolError('unsupported', 'Refund payment kind is unsupported', 'rejected');
}
export function validateCommand(command: RefundCommand, kinds: readonly string[]): void {
  validatePayment(command.payment, kinds); exactMoney(command.money, true); identity(command.commandKey);
  if (command.money.currency !== command.payment.paidMoney.currency) throw new RefundProtocolError('invalid_input', 'Refund currency differs from the payment', 'rejected');
  if (command.commandKey.length > 108 || command.reason !== undefined && (typeof command.reason !== 'string' || command.reason.length > 255 || /[\u0000-\u001f\u007f]/.test(command.reason))) {
    throw new RefundProtocolError('invalid_input', 'Refund command key or reason is invalid', 'rejected');
  }
  if (compareMoney(command.money, command.payment.paidMoney) > 0) throw new RefundProtocolError('invalid_input', 'Refund exceeds the bound paid amount', 'rejected');
}
export function sameIdentity(actual: unknown, expected: string): void {
  if (actual !== expected) throw new RefundProtocolError('verification_failed', 'Refund resource differs from the bound payment');
}
/** Never forward provider SDK errors or response bodies to a consumer's public error path. */
export async function protocolCall<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof RefundProtocolError) throw error;
    const stripe = error && typeof error === 'object' ? error as { type?: unknown; statusCode?: unknown } : undefined;
    const rejected = typeof stripe?.type === 'string' && ['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError'].includes(stripe.type)
      && typeof stripe.statusCode === 'number' && [400, 401, 403, 404, 422].includes(stripe.statusCode);
    throw new RefundProtocolError('transport_error', 'Refund provider request failed; reconcile before another mutation', rejected ? 'rejected' : 'unknown');
  }
}
