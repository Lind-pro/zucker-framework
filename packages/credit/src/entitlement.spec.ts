import { describe, expect, it } from 'vitest';
import {
  EntitlementService,
  EntitlementValidationError,
  counterLimit,
  counterSnapshot,
  isActiveTerm,
  meteredCounters,
  periodKey,
  resolveEntitlements,
  validateEntitlementCatalog,
  validatePlanGrant,
  type EntitlementCatalog,
} from './entitlement';

const catalog: EntitlementCatalog = {
  features: [
    { key: 'reports', category: 'metered', counter: 'reports_per_month' },
    { key: 'exports', category: 'metered', counter: 'exports_per_day' },
    { key: 'adFree', category: 'benefit' },
  ],
  counters: [
    { key: 'reports_per_month', period: 'month' },
    { key: 'exports_per_day', period: 'day' },
    { key: 'seats', period: 'lifetime' },
  ],
};
const at = new Date('2026-06-15T12:00:00Z');
const day = 86_400_000;

function issues(work: () => unknown): readonly string[] {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(EntitlementValidationError);
    return (error as EntitlementValidationError).issues;
  }
  throw new Error('expected a validation error');
}

describe('entitlement catalog', () => {
  it('accepts a consistent catalog and lists metered counters', () => {
    expect(validateEntitlementCatalog(catalog)).toBe(catalog);
    expect([...meteredCounters(catalog)]).toEqual(['reports_per_month', 'exports_per_day']);
  });
  it('rejects malformed, duplicate and inconsistent definitions', () => {
    expect(issues(() => validateEntitlementCatalog({} as EntitlementCatalog))).toEqual([
      'catalog must contain features and counters arrays',
    ]);
    const found = issues(() =>
      validateEntitlementCatalog({
        features: [
          { key: 'a', category: 'metered', counter: 'missing' },
          { key: 'a', category: 'benefit' },
          { key: 'b', category: 'benefit', counter: 'c' },
          { key: 'c d', category: 'benefit' },
          { key: 'e', category: 'other' as 'benefit' },
        ],
        counters: [
          { key: 'c', period: 'month' },
          { key: 'c', period: 'day' },
          { key: 'z', period: 'year' as 'month' },
          { key: '9', period: 'day' },
        ],
      }),
    );
    expect(found).toEqual([
      'duplicate counter c',
      'invalid period for counter z',
      'invalid counter key 9',
      'metered feature a needs a declared counter',
      'duplicate feature a',
      'benefit feature b cannot reference a counter',
      'invalid feature key c d',
      'invalid category for feature e',
    ]);
  });
});

describe('plan grants', () => {
  it('returns a validated copy of declared booleans and quotas', () => {
    const grant = { features: { reports: true, adFree: false }, quotas: { reports_per_month: 10, seats: -1 } };
    const result = validatePlanGrant(catalog, grant);
    expect(result).toEqual(grant);
    expect(result.features).not.toBe(grant.features);
    expect(validatePlanGrant(catalog, {})).toEqual({ features: {}, quotas: {} });
  });
  it('rejects non-booleans, unknown keys and invalid quota numbers', () => {
    expect(issues(() => validatePlanGrant(catalog, null))).toEqual(['grant must be an object']);
    expect(issues(() => validatePlanGrant(catalog, { features: [], quotas: 'x' }))).toEqual([
      'features must be an object',
      'quotas must be an object',
    ]);
    expect(
      issues(() =>
        validatePlanGrant(catalog, {
          features: { reports: 'yes', other: true },
          quotas: { reports_per_month: -2, exports_per_day: 1.5, seats: Number.NaN, other: 1 },
        }),
      ),
    ).toEqual([
      'feature reports must be a boolean',
      'unknown feature other',
      'quota reports_per_month must be -1 or a non-negative integer',
      'quota exports_per_day must be -1 or a non-negative integer',
      'quota seats must be -1 or a non-negative integer',
      'unknown counter other',
    ]);
    expect(issues(() => validatePlanGrant(catalog, { quotas: { seats: 2 ** 60 } }))).toHaveLength(1);
  });
  it('defaults missing metered counters to no allowance and others to unlimited', () => {
    expect(counterLimit(catalog, { reports_per_month: 5 }, 'reports_per_month')).toBe(5);
    expect(counterLimit(catalog, {}, 'reports_per_month')).toBe(0);
    expect(counterLimit(catalog, null, 'seats')).toBe(-1);
    expect(counterLimit(catalog, { reports_per_month: 'lots', seats: -7 }, 'reports_per_month')).toBe(0);
    expect(counterLimit(catalog, { seats: -7 }, 'seats')).toBe(-1);
    expect(issues(() => counterLimit(catalog, {}, 'unknown'))).toEqual(['unknown counter unknown']);
  });
});

describe('subscription terms', () => {
  const term = (patch: Partial<Parameters<typeof isActiveTerm>[0] & object>) => ({
    status: 'ACTIVE',
    startDate: new Date(at.getTime() - day),
    endDate: new Date(at.getTime() + day),
    billingCycle: 'MONTHLY',
    ...patch,
  });
  it('accepts started ACTIVE/CANCELED terms with a future end', () => {
    expect(isActiveTerm(term({}), at)).toBe(true);
    expect(isActiveTerm(term({ status: 'CANCELED' }), at)).toBe(true);
  });
  it('accepts ACTIVE lifetime terms without an end', () => {
    expect(isActiveTerm(term({ billingCycle: 'LIFETIME', endDate: null }), at)).toBe(true);
    expect(isActiveTerm(term({ status: 'CANCELED', billingCycle: 'LIFETIME', endDate: null }), at)).toBe(false);
    expect(isActiveTerm(term({ endDate: null }), at)).toBe(false);
  });
  it('rejects other states, future starts, past ends and invalid dates', () => {
    expect(isActiveTerm(null, at)).toBe(false);
    expect(isActiveTerm(term({ status: 'EXPIRED' }), at)).toBe(false);
    expect(isActiveTerm(term({ status: 'PENDING' }), at)).toBe(false);
    expect(isActiveTerm(term({ startDate: new Date(at.getTime() + 1) }), at)).toBe(false);
    expect(isActiveTerm(term({ endDate: at }), at)).toBe(false);
    expect(isActiveTerm(term({ startDate: null }), at)).toBe(false);
    expect(isActiveTerm(term({ endDate: new Date(Number.NaN) }), at)).toBe(false);
    expect(isActiveTerm(term({}), new Date(Number.NaN))).toBe(false);
  });
});

describe('period keys', () => {
  it('formats month/day periods in the configured time zone', () => {
    const instant = new Date('2026-01-31T16:30:00Z');
    expect(periodKey('month', instant)).toBe('2026-01');
    expect(periodKey('day', instant)).toBe('2026-01-31');
    expect(periodKey('month', instant, 'Asia/Shanghai')).toBe('2026-02');
    expect(periodKey('day', instant, 'Asia/Shanghai')).toBe('2026-02-01');
    expect(periodKey('day', new Date('2026-03-01T02:00:00Z'), 'America/Los_Angeles')).toBe('2026-02-28');
    expect(periodKey('lifetime', instant, 'Asia/Shanghai')).toBe('lifetime');
  });
  it('rejects invalid periods, dates and zones', () => {
    expect(issues(() => periodKey('year' as 'month', at))).toEqual(['invalid period year']);
    expect(issues(() => periodKey('day', new Date(Number.NaN)))).toEqual(['invalid date']);
    expect(issues(() => periodKey('day', at, 'Mars/Base'))).toEqual(['invalid time zone Mars/Base']);
  });
});

describe('resolved entitlements', () => {
  const active = { status: 'ACTIVE', startDate: new Date(0), endDate: new Date(at.getTime() + day), billingCycle: 'MONTHLY' };
  it('resolves catalog features and limits for an active term', () => {
    expect(
      resolveEntitlements({
        catalog,
        grant: { features: { reports: true, adFree: 'true', legacy: true }, quotas: { reports_per_month: 3 } },
        term: active,
        now: at,
      }),
    ).toEqual({
      active: true,
      features: { reports: true, exports: false, adFree: false },
      limits: { reports_per_month: 3, exports_per_day: 0, seats: -1 },
    });
  });
  it('grants nothing without an active term or plan', () => {
    const none = { active: false, features: { reports: false, exports: false, adFree: false },
      limits: { reports_per_month: 0, exports_per_day: 0, seats: 0 } };
    expect(resolveEntitlements({ catalog, grant: { features: { reports: true } }, term: { ...active, status: 'EXPIRED' }, now: at })).toEqual(none);
    expect(resolveEntitlements({ catalog, grant: null, term: active, now: at })).toEqual(none);
  });
  it('builds counter snapshots and rejects corrupt usage', () => {
    expect(counterSnapshot({ limit: 5, used: 4, reserved: 3, period: 'p' })).toEqual({
      limit: 5, used: 4, reserved: 3, remaining: 0, period: 'p' });
    expect(counterSnapshot({ limit: -1, used: 4, reserved: 0, period: 'p' }).remaining).toBe(-1);
    expect(issues(() => counterSnapshot({ limit: 5, used: -1, reserved: 0, period: 'p' }))).toEqual(['invalid used amount']);
    expect(issues(() => counterSnapshot({ limit: 5, used: 0, reserved: 0.5, period: 'p' }))).toEqual(['invalid reserved amount']);
    expect(issues(() => counterSnapshot({ limit: -2, used: 0, reserved: 0, period: 'p' }))).toEqual(['invalid limit']);
  });
});

describe('EntitlementService', () => {
  it('binds the catalog, time zone and clock', () => {
    const service = new EntitlementService({ catalog, timeZone: 'Asia/Shanghai', now: () => new Date('2026-01-31T16:30:00Z') });
    expect(service.period('reports_per_month')).toBe('2026-02');
    expect(service.period('exports_per_day')).toBe('2026-02-01');
    expect(service.period('seats')).toBe('lifetime');
    expect(service.feature('reports').counter).toBe('reports_per_month');
    expect(service.limit({}, 'exports_per_day')).toBe(0);
    expect(service.validateGrant({ features: { adFree: true } })).toEqual({ features: { adFree: true }, quotas: {} });
    expect(service.isActive({ status: 'ACTIVE', startDate: new Date(0), endDate: null, billingCycle: 'LIFETIME' })).toBe(true);
    expect(service.resolve({ features: { adFree: true } }, null).active).toBe(false);
    expect(issues(() => service.counter('nope'))).toEqual(['unknown counter nope']);
    expect(issues(() => service.feature('nope'))).toEqual(['unknown feature nope']);
  });
  it('fails fast for an invalid catalog or zone', () => {
    expect(() => new EntitlementService({ catalog, timeZone: 'Nowhere/Zone' })).toThrow(EntitlementValidationError);
    expect(() => new EntitlementService({ catalog: { features: [{ key: 'x', category: 'metered' }], counters: [] } })).toThrow(
      'metered feature x needs a declared counter',
    );
  });
});
