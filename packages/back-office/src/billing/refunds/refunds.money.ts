import { HostedCheckoutError, currencyExponent, type Money } from '@zucker-framework/payment';
export function minorAmount(amount: string, currency: string, scale = currencyExponent(currency)): bigint {
  if (typeof amount !== 'string' || amount.length > 40 || !/^\d+(?:\.\d+)?$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) throw new HostedCheckoutError('invalid_input', 'Invalid exact refund amount');
  const [whole, rawFraction = ''] = amount.split('.'), fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > scale) throw new HostedCheckoutError('invalid_input', 'Refund amount has unsupported currency decimals');
  const value = BigInt(whole + fraction.padEnd(scale, '0'));
  if (value.toString().length > 38) throw new HostedCheckoutError('invalid_input', 'Refund amount exceeds the supported range');
  return value;
}
export function minorMoney(value: bigint | string, currency: string, scale: number): Money {
  const digits = BigInt(value).toString().padStart(scale + 1, '0');
  return { amount: scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits, currency };
}
export function requiredCredits(total: number, refunded: bigint | string, paid: bigint | string): number {
  return Number(BigInt(total) * BigInt(refunded) / BigInt(paid));
}
