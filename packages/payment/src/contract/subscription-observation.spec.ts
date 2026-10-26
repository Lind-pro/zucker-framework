import { describe, expect, it } from 'vitest';
import { subscriptionPeriodKey } from './subscription-observation';

const input = { provider: 'synthetic', accountScope: 'merchant-a', subscriptionId: 'sub-1',
  period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } };
describe('subscription period identity', () => {
  it('normalizes equivalent timestamps and scopes cycles by provider account and subscription', () => {
    expect(subscriptionPeriodKey(input)).toBe(subscriptionPeriodKey({ ...input,
      period: { start: '2026-10-01T08:00:00+08:00', end: '2026-11-01T08:00:00+08:00' } }));
    for (const changed of [{ accountScope: 'merchant-b' }, { provider: 'another' }, { subscriptionId: 'sub-2' }]) {
      expect(subscriptionPeriodKey({ ...input, ...changed })).not.toBe(subscriptionPeriodKey(input));
    }
  });
  it('requires a real bounded period and nonempty namespaced identity', () => {
    for (const changed of [{ accountScope: '' }, { subscriptionId: '' }, { provider: '' },
      { period: { start: 'invalid', end: input.period.end } }, { period: { start: input.period.end, end: input.period.start } }]) {
      expect(() => subscriptionPeriodKey({ ...input, ...changed })).toThrow();
    }
  });
});
