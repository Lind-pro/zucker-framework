import { currencyExponent, fromMinorUnits, fromStripeMinorUnits, toMinorUnits, toStripeMinorUnits } from './money';

describe('minor-unit conversion (M1)', () => {
  it('uses three decimals for BHD/JOD/KWD/OMR/TND', () => {
    expect(currencyExponent('kwd')).toBe(3);
    expect(toMinorUnits('10.000', 'KWD')).toBe(10000);
    expect(toMinorUnits('10.5', 'BHD')).toBe(10500);
    expect(fromMinorUnits(10000, 'KWD')).toBe('10.000');
    expect(() => toMinorUnits('1.0001', 'TND')).toThrow();
  });
  it('maps Stripe special cases: UGX/ISK use two API decimals for whole amounts', () => {
    expect(toStripeMinorUnits('5000', 'UGX')).toBe(500000);
    expect(toStripeMinorUnits('500', 'ISK')).toBe(50000);
    expect(() => toStripeMinorUnits('5000.50', 'UGX')).toThrow();
    expect(fromStripeMinorUnits(500000, 'UGX')).toBe('5000.00');
    expect(toStripeMinorUnits('500', 'JPY')).toBe(500);
    expect(toStripeMinorUnits('29.00', 'USD')).toBe(2900);
  });
  it('requires Stripe three-decimal amounts to end in zero', () => {
    expect(toStripeMinorUnits('10.000', 'KWD')).toBe(10000);
    expect(toStripeMinorUnits('10.12', 'KWD')).toBe(10120);
    expect(() => toStripeMinorUnits('10.123', 'KWD')).toThrow('0');
  });
  it('rejects malformed currency codes instead of assuming two decimals', () => {
    expect(() => currencyExponent('US')).toThrow();
    expect(() => toMinorUnits('1.00', 'dollars')).toThrow();
  });
});
