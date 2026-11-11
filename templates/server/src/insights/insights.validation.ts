import { BadRequestException } from '@nestjs/common';

/**
 * Query parsing for `/management/insights/*`. Every value is untrusted: keys are exact, `days` is a
 * bounded integer and `tz` must be an IANA zone known to this runtime (it is later bound as a SQL
 * parameter, never interpolated).
 */
export const INSIGHT_METRICS = ['revenue', 'refunds', 'new-users', 'paying-users', 'active-subscriptions',
  'credits-granted', 'credits-consumed', 'ai-tasks', 'chat-messages', 'signups-by-source'] as const;
export type InsightMetric = (typeof INSIGHT_METRICS)[number];

export const INSIGHT_DAYS = Object.freeze({ min: 1, max: 366, fallback: 30 });

export interface InsightRangeQuery { days: number; tz: string }
export interface InsightSeriesQuery extends InsightRangeQuery { metric: InsightMetric }

const invalid = (field: string, message = `Invalid ${field}`) =>
  new BadRequestException({ code: 'INSIGHTS_INVALID', message, details: { field } });

let zones: ReadonlySet<string> | undefined;
/** IANA zones of this runtime plus `UTC` (Node lists `Etc/UTC` but not the `UTC` alias). */
export function isSupportedTimeZone(value: string): boolean {
  zones ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Etc/UTC']);
  return zones.has(value);
}

function single(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(key, `${key} must be given once`);
  return value;
}

function parseRange(query: Record<string, unknown>): InsightRangeQuery {
  const rawDays = single(query, 'days'), rawTz = single(query, 'tz');
  let days: number = INSIGHT_DAYS.fallback;
  if (rawDays !== undefined) {
    if (!/^[0-9]{1,3}$/.test(rawDays)) throw invalid('days', `days must be an integer ${INSIGHT_DAYS.min}-${INSIGHT_DAYS.max}`);
    days = Number(rawDays);
    if (days < INSIGHT_DAYS.min || days > INSIGHT_DAYS.max) throw invalid('days', `days must be an integer ${INSIGHT_DAYS.min}-${INSIGHT_DAYS.max}`);
  }
  const tz = rawTz ?? 'UTC';
  if (tz.length > 64 || !isSupportedTimeZone(tz)) throw invalid('tz', 'tz must be an IANA time zone');
  return { days, tz };
}

const assertKeys = (query: Record<string, unknown>, allowed: readonly string[]) => {
  const unknown = Object.keys(query).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw invalid('query', 'Unsupported query parameter');
};

/** `?days=1..366&tz=<IANA>` (defaults 30 and UTC). */
export function parseSummaryQuery(query: Record<string, unknown> = {}): InsightRangeQuery {
  assertKeys(query, ['days', 'tz']);
  return parseRange(query);
}

/** `?metric=<id>&days=1..366&tz=<IANA>`. */
export function parseSeriesQuery(query: Record<string, unknown> = {}): InsightSeriesQuery {
  assertKeys(query, ['metric', 'days', 'tz']);
  const metric = single(query, 'metric');
  if (!metric || !(INSIGHT_METRICS as readonly string[]).includes(metric)) throw invalid('metric', 'Unknown metric');
  return { metric: metric as InsightMetric, ...parseRange(query) };
}
