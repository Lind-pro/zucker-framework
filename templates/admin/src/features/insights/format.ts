/**
 * Display helpers and response types of the insights page. Money arrives as exact decimal strings
 * per currency and is never added across currencies; numbers are only parsed for drawing and for
 * locale formatting, and the table view keeps the server's exact string.
 */

export const INSIGHT_RANGES = [7, 30, 90, 365] as const;

export type Unavailable = { available: false };
export interface MoneyTotal { currency: string; amount: string }
export interface InsightRange { days: number; tz: string; from: string; to: string; asOf: string }

/** `GET /management/insights/summary`. */
export interface InsightSummary {
  range: InsightRange;
  metrics: {
    revenue: Unavailable | { available: true; totals: MoneyTotal[] };
    refunds: Unavailable | { available: true; totals: MoneyTotal[] };
    'new-users': Unavailable | { available: true; value: number };
    'paying-users': Unavailable | { available: true; value: number };
    'active-subscriptions': Unavailable | { available: true; value: number; provider: number };
    'credits-granted': Unavailable | { available: true; value: number };
    'credits-consumed': Unavailable | { available: true; value: number };
    'ai-tasks': Unavailable | { available: true; value: number; breakdown: Array<{ kind: string; status: string; count: number }> };
    'chat-messages': Unavailable | { available: true; value: number };
    'signups-by-source': Unavailable | { available: true; items: Array<{ source: string; count: number }>; attributed: number; unattributed: number };
  };
}

export interface InsightPoint { date: string; value: number | string }
export interface DailySeries { key: string; total?: number | string; points: InsightPoint[] }
/** `GET /management/insights/series`. */
export type InsightSeries = { metric: string; range: InsightRange; unit: 'money' | 'count' | 'credits' } & (
  | Unavailable
  | { available: true; kind: 'daily'; series: DailySeries[] }
  | { available: true; kind: 'point'; value: number; provider: number }
  | { available: true; kind: 'ranking'; items: Array<{ key: string; value: number }>; unattributed: number });

/** The browser's IANA zone, or UTC when the runtime does not report one. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Decimal string or number to a finite number for drawing; anything else is 0. */
export function toNumber(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Full integer under 10,000, compact above (1,284 / 12.9K). */
export function formatCount(value: number, locale: string): string {
  return Math.abs(value) < 10_000
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
    : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Money with its own currency symbol; falls back to `amount CUR` for codes the runtime rejects. */
export function formatMoney(amount: string, currency: string, locale: string, compact = false): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}) })
      .format(toNumber(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Short day label for an axis (`Mar 9`), from a `YYYY-MM-DD` calendar date (no zone shift). */
export function formatDay(date: string, locale: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.UTC(year, month - 1, day));
}

/**
 * Clean axis ticks from 0 to a rounded maximum (1/2/2.5/5 × 10^n steps), about `count + 1` ticks.
 * `integer` keeps steps whole for counts.
 */
export function niceTicks(max: number, count = 4, integer = false): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count, power = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? 10 * power;
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}
