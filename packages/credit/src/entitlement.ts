/**
 * Plan entitlement mechanics: catalog validation, plan grants, subscription term validity,
 * counter periods and effective features/limits. The feature catalog, labels, plan contents and
 * prices are consumer policy and are always passed in; nothing here names a product feature.
 */

/** A counter's accounting window. `lifetime` never resets. */
export type EntitlementCounterPeriod = 'month' | 'day' | 'lifetime';
/** `metered` features consume a counter; `benefit` features are plain switches. */
export type EntitlementFeatureCategory = 'metered' | 'benefit';

export interface EntitlementFeatureDefinition {
  key: string;
  category: EntitlementFeatureCategory;
  /** Counter charged when a metered feature is used. Benefits may not reference a counter. */
  counter?: string;
}
export interface EntitlementCounterDefinition {
  key: string;
  period: EntitlementCounterPeriod;
}
/** Consumers may extend definitions with labels, units and descriptions for presentation. */
export interface EntitlementCatalog<
  F extends EntitlementFeatureDefinition = EntitlementFeatureDefinition,
  C extends EntitlementCounterDefinition = EntitlementCounterDefinition,
> {
  features: readonly F[];
  counters: readonly C[];
}

/** Value stored with a plan. `-1` is an explicit unlimited quota. */
export interface PlanGrant {
  features: Record<string, boolean>;
  quotas: Record<string, number>;
}
export const UNLIMITED_QUOTA = -1;

export class EntitlementValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid entitlement configuration: ${issues.join('; ')}`);
    this.name = 'EntitlementValidationError';
  }
}

const KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const PERIODS: readonly EntitlementCounterPeriod[] = ['month', 'day', 'lifetime'];
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Rejects duplicate/malformed keys, unknown periods and metered features without a declared counter. */
export function validateEntitlementCatalog<C extends EntitlementCatalog>(catalog: C): C {
  const issues: string[] = [];
  if (!isRecord(catalog) || !Array.isArray(catalog.features) || !Array.isArray(catalog.counters))
    throw new EntitlementValidationError(['catalog must contain features and counters arrays']);
  const counters = new Set<string>();
  for (const counter of catalog.counters) {
    if (!isRecord(counter) || typeof counter.key !== 'string' || !KEY.test(counter.key))
      issues.push(`invalid counter key ${String((counter as { key?: unknown })?.key)}`);
    else if (counters.has(counter.key)) issues.push(`duplicate counter ${counter.key}`);
    else counters.add(counter.key);
    if (!PERIODS.includes((counter as { period?: EntitlementCounterPeriod })?.period as EntitlementCounterPeriod))
      issues.push(`invalid period for counter ${String((counter as { key?: unknown })?.key)}`);
  }
  const features = new Set<string>();
  for (const feature of catalog.features) {
    const key = (feature as { key?: unknown })?.key;
    if (!isRecord(feature) || typeof key !== 'string' || !KEY.test(key)) {
      issues.push(`invalid feature key ${String(key)}`);
      continue;
    }
    if (features.has(key)) issues.push(`duplicate feature ${key}`);
    features.add(key);
    if (feature.category === 'metered') {
      if (typeof feature.counter !== 'string' || !counters.has(feature.counter))
        issues.push(`metered feature ${key} needs a declared counter`);
    } else if (feature.category === 'benefit') {
      if (feature.counter !== undefined) issues.push(`benefit feature ${key} cannot reference a counter`);
    } else issues.push(`invalid category for feature ${key}`);
  }
  if (issues.length) throw new EntitlementValidationError(issues);
  return catalog;
}

/** Counters charged by at least one metered feature; an omitted quota for them means no allowance. */
export function meteredCounters(catalog: EntitlementCatalog): ReadonlySet<string> {
  return new Set(
    catalog.features
      .filter((feature) => feature.category === 'metered' && feature.counter)
      .map((feature) => feature.counter as string),
  );
}

/**
 * Validates an administrator-supplied grant against the catalog. Feature values must be booleans
 * and quotas `-1` or non-negative safe integers; every key must be declared. Returns a copy.
 */
export function validatePlanGrant(catalog: EntitlementCatalog, grant: unknown): PlanGrant {
  if (!isRecord(grant)) throw new EntitlementValidationError(['grant must be an object']);
  const issues: string[] = [];
  const features: Record<string, boolean> = {};
  const quotas: Record<string, number> = {};
  const featureKeys = new Set(catalog.features.map((feature) => feature.key));
  const counterKeys = new Set(catalog.counters.map((counter) => counter.key));
  const rawFeatures = grant.features ?? {};
  const rawQuotas = grant.quotas ?? {};
  if (!isRecord(rawFeatures)) issues.push('features must be an object');
  else
    for (const [key, value] of Object.entries(rawFeatures)) {
      if (!featureKeys.has(key)) issues.push(`unknown feature ${key}`);
      else if (typeof value !== 'boolean') issues.push(`feature ${key} must be a boolean`);
      else features[key] = value;
    }
  if (!isRecord(rawQuotas)) issues.push('quotas must be an object');
  else
    for (const [key, value] of Object.entries(rawQuotas)) {
      if (!counterKeys.has(key)) issues.push(`unknown counter ${key}`);
      else if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        (value < 0 && value !== UNLIMITED_QUOTA)
      )
        issues.push(`quota ${key} must be -1 or a non-negative integer`);
      else quotas[key] = value;
    }
  if (issues.length) throw new EntitlementValidationError(issues);
  return { features, quotas };
}

/**
 * Effective limit of one counter for a grant. Missing metered counters allow nothing; other missing
 * counters are unlimited. Unknown counters are rejected rather than guessed.
 */
export function counterLimit(catalog: EntitlementCatalog, quotas: unknown, counter: string): number {
  if (!catalog.counters.some((item) => item.key === counter))
    throw new EntitlementValidationError([`unknown counter ${counter}`]);
  const value = isRecord(quotas) ? quotas[counter] : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= UNLIMITED_QUOTA) return value;
  // Malformed stored values never widen access for a metered counter.
  return meteredCounters(catalog).has(counter) ? 0 : UNLIMITED_QUOTA;
}

export interface SubscriptionTerm {
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  billingCycle?: string | null;
}

/**
 * ACTIVE or CANCELED terms are valid from a started start date until a future end date (cancellation
 * keeps its paid period). An ACTIVE LIFETIME term may have no end. All other states are inactive.
 */
export function isActiveTerm(term: SubscriptionTerm | null | undefined, now: Date = new Date()): boolean {
  if (!term || (term.status !== 'ACTIVE' && term.status !== 'CANCELED')) return false;
  const at = now.getTime();
  const start = term.startDate instanceof Date ? term.startDate.getTime() : Number.NaN;
  if (!Number.isFinite(at) || !Number.isFinite(start) || start > at) return false;
  if (term.endDate === null)
    return term.status === 'ACTIVE' && term.billingCycle === 'LIFETIME';
  const end = term.endDate instanceof Date ? term.endDate.getTime() : Number.NaN;
  return Number.isFinite(end) && end > at;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        calendar: 'gregory',
        numberingSystem: 'latn',
      });
    } catch {
      throw new EntitlementValidationError([`invalid time zone ${timeZone}`]);
    }
    formatters.set(timeZone, value);
  }
  return value;
}

/** Stable period key in the given IANA time zone: `YYYY-MM`, `YYYY-MM-DD` or `lifetime`. */
export function periodKey(period: EntitlementCounterPeriod, now: Date = new Date(), timeZone = 'UTC'): string {
  if (period === 'lifetime') return 'lifetime';
  if (period !== 'month' && period !== 'day')
    throw new EntitlementValidationError([`invalid period ${String(period)}`]);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new EntitlementValidationError(['invalid date']);
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const year = parts.year.padStart(4, '0');
  return period === 'month' ? `${year}-${parts.month}` : `${year}-${parts.month}-${parts.day}`;
}

export interface ResolvedEntitlements {
  active: boolean;
  features: Record<string, boolean>;
  /** Every catalog counter's effective limit; `-1` is unlimited. Inactive terms resolve to 0. */
  limits: Record<string, number>;
}

/**
 * Effective features and counter limits for a plan grant and its subscription term. Without an
 * active term every feature is off and every counter has no allowance. Stored keys outside the
 * catalog are ignored, so retiring a feature from code cannot leave a hidden grant active.
 */
export function resolveEntitlements(input: {
  catalog: EntitlementCatalog;
  grant: { features?: unknown; quotas?: unknown } | null | undefined;
  term: SubscriptionTerm | null | undefined;
  now?: Date;
}): ResolvedEntitlements {
  const active = !!input.grant && isActiveTerm(input.term, input.now ?? new Date());
  const stored = active && isRecord(input.grant?.features) ? input.grant.features : {};
  const features = Object.fromEntries(
    input.catalog.features.map((feature) => [feature.key, stored[feature.key] === true]),
  );
  const limits = Object.fromEntries(
    input.catalog.counters.map((counter) => [
      counter.key,
      active ? counterLimit(input.catalog, input.grant?.quotas, counter.key) : 0,
    ]),
  );
  return { active, features, limits };
}

export interface CounterSnapshot {
  limit: number;
  used: number;
  reserved: number;
  /** `-1` when the limit is unlimited; otherwise never negative. */
  remaining: number;
  period: string;
}

/** Presentation snapshot of one counter; corrupt negative usage is rejected instead of hidden. */
export function counterSnapshot(input: { limit: number; used: number; reserved: number; period: string }): CounterSnapshot {
  for (const field of ['used', 'reserved'] as const)
    if (!Number.isSafeInteger(input[field]) || input[field] < 0)
      throw new EntitlementValidationError([`invalid ${field} amount`]);
  if (!Number.isSafeInteger(input.limit) || input.limit < UNLIMITED_QUOTA)
    throw new EntitlementValidationError(['invalid limit']);
  const remaining =
    input.limit === UNLIMITED_QUOTA ? UNLIMITED_QUOTA : Math.max(0, input.limit - input.used - input.reserved);
  return { limit: input.limit, used: input.used, reserved: input.reserved, remaining, period: input.period };
}

export interface EntitlementServiceOptions<C extends EntitlementCatalog> {
  catalog: C;
  /** IANA zone used for month/day boundaries. Defaults to UTC. */
  timeZone?: string;
  now?: () => Date;
}

/** Validated catalog plus its configured time zone; stateless and safe to share. */
export class EntitlementService<C extends EntitlementCatalog = EntitlementCatalog> {
  readonly catalog: C;
  readonly timeZone: string;
  private readonly clock: () => Date;
  constructor(options: EntitlementServiceOptions<C>) {
    this.catalog = validateEntitlementCatalog(options.catalog);
    this.timeZone = options.timeZone ?? 'UTC';
    periodKey('month', new Date(0), this.timeZone); // fail fast on an invalid zone
    this.clock = options.now ?? (() => new Date());
  }
  validateGrant(grant: unknown): PlanGrant {
    return validatePlanGrant(this.catalog, grant);
  }
  counter(key: string): C['counters'][number] {
    const counter = this.catalog.counters.find((item) => item.key === key);
    if (!counter) throw new EntitlementValidationError([`unknown counter ${key}`]);
    return counter;
  }
  /** Feature definition, including its counter for metered features. */
  feature(key: string): C['features'][number] {
    const feature = this.catalog.features.find((item) => item.key === key);
    if (!feature) throw new EntitlementValidationError([`unknown feature ${key}`]);
    return feature;
  }
  period(counter: string, now: Date = this.clock()): string {
    return periodKey(this.counter(counter).period, now, this.timeZone);
  }
  limit(quotas: unknown, counter: string): number {
    return counterLimit(this.catalog, quotas, counter);
  }
  isActive(term: SubscriptionTerm | null | undefined, now: Date = this.clock()): boolean {
    return isActiveTerm(term, now);
  }
  resolve(
    grant: { features?: unknown; quotas?: unknown } | null | undefined,
    term: SubscriptionTerm | null | undefined,
    now: Date = this.clock(),
  ): ResolvedEntitlements {
    return resolveEntitlements({ catalog: this.catalog, grant, term, now });
  }
}
