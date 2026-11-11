import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import {
  activeSubscriptions, additiveDaily, additiveTotals, aiTaskBreakdown, isAdditive, METRIC_TABLES, METRIC_UNITS, payersDaily,
  payersTotal, presentTables, resolveWindow, signupSources, type DailyValue, type InsightUnit, type InsightWindow,
} from './insights.queries';
import { parseSeriesQuery, parseSummaryQuery, type InsightMetric } from './insights.validation';

/** Optional clock for tests; production uses the system time. */
export const INSIGHTS_CLOCK = Symbol('INSIGHTS_CLOCK');
export type InsightsClock = () => Date;

/** Per-process result cache: 60 s, bounded entry count, keyed by every parameter that shapes the result. */
export const INSIGHTS_CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 256;
/** Per-statement ceiling: an aggregate that cannot finish in time is refused, never left running. */
export const INSIGHTS_STATEMENT_TIMEOUT = '5s';

export interface InsightRange { days: number; tz: string; from: string; to: string; asOf: string }
export type Unavailable = { available: false };
export interface MoneyTotal { currency: string; amount: string }

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
/** One key (currency, AI status or `total`) with a point per local day. */
export interface DailySeries { key: string; total?: number | string; points: InsightPoint[] }
export type InsightSeries = { metric: InsightMetric; range: InsightRange; unit: InsightUnit } & (
  | Unavailable
  | { available: true; kind: 'daily'; series: DailySeries[] }
  | { available: true; kind: 'point'; value: number; provider: number }
  | { available: true; kind: 'ranking'; items: Array<{ key: string; value: number }>; unattributed: number });

const UNAVAILABLE: Unavailable = Object.freeze({ available: false });
/** Daily keys of each metric that always appear (zero-filled) even with no rows. */
const FIXED_KEYS: Partial<Record<InsightMetric, readonly string[]>> = {
  'new-users': ['total'], 'paying-users': ['total'], 'credits-granted': ['total'], 'credits-consumed': ['total'], 'chat-messages': ['total'],
  'ai-tasks': ['completed', 'failed', 'cancelled', 'in_progress'],
};

/** Integer counts and credit sums travel as numbers; money stays a decimal string per currency. */
const numeric = (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Aggregate exceeds the safe integer range');
  return parsed;
};

/** PostgreSQL SQLSTATE of a (possibly wrapped) driver error; Prisma raw errors carry it in the message. */
function sqlState(error: unknown): string | undefined {
  for (let current = error as Record<string, unknown> | undefined, depth = 0; current && depth < 5; depth += 1) {
    const meta = current.meta as Record<string, unknown> | undefined;
    for (const value of [meta?.code, current.originalCode, current.code])
      if (typeof value === 'string' && /^[0-9A-Z]{2}[0-9A-Z]{3}$/.test(value) && !/^P[0-9]{4}$/.test(value)) return value;
    const message = typeof current.message === 'string' ? current.message : '';
    const coded = /Code: `([0-9A-Z]{5})`/.exec(message)?.[1];
    if (coded) return coded;
    if (/canceling statement due to statement timeout/.test(message)) return '57014';
    current = (current.cause ?? undefined) as Record<string, unknown> | undefined;
  }
  return undefined;
}

/**
 * Operations insights: revenue, refunds, sign-ups, payers, subscriptions, credits and AI usage from
 * existing tables. Read-only aggregates in a READ ONLY transaction with a statement timeout; results
 * are cached per process for 60 s. Never returns user ids, emails or IPs.
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);
  private readonly cache = new Map<string, { expires: number; value: Promise<unknown> }>();
  private readonly clock: InsightsClock;

  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Optional() @Inject(INSIGHTS_CLOCK) clock?: InsightsClock) {
    this.clock = clock ?? (() => new Date());
  }

  summary(query: Record<string, unknown> = {}): Promise<InsightSummary> {
    const { days, tz } = parseSummaryQuery(query);
    return this.cached(`summary|${days}|${tz}`, () => this.read(days, tz, (tx, range, window, present) => this.buildSummary(tx, range, window, present)));
  }

  series(query: Record<string, unknown> = {}): Promise<InsightSeries> {
    const { metric, days, tz } = parseSeriesQuery(query);
    return this.cached(`series|${metric}|${days}|${tz}`, () => this.read(days, tz, (tx, range, window, present, dates) =>
      this.buildSeries(tx, metric, range, window, present, dates)));
  }

  /** Drops every cached result (tests and operators after a data repair). */
  clearCache(): void { this.cache.clear(); }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now(), hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    if (hit) this.cache.delete(key);
    while (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    // Concurrent requests share one in-flight load; a failed load is never cached.
    const value = load();
    this.cache.set(key, { expires: now + INSIGHTS_CACHE_TTL_MS, value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  private async read<T>(days: number, tz: string,
    work: (tx: ApplicationTransaction, range: InsightRange, window: InsightWindow, present: Set<string>, dates: string[]) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(async tx => {
        await tx.query('SET TRANSACTION READ ONLY');
        await tx.query(`SET LOCAL statement_timeout = '${INSIGHTS_STATEMENT_TIMEOUT}'`);
        const resolved = await resolveWindow(tx, days, tz, this.clock());
        const present = await presentTables(tx, [...new Set(Object.values(METRIC_TABLES).flat())]);
        const range: InsightRange = { days, tz, from: resolved.first, to: resolved.last, asOf: resolved.window.asOf };
        return work(tx, range, resolved.window, present, resolved.dates);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const state = sqlState(error);
      if (state === '57014') {
        this.logger.warn(`Insights query exceeded ${INSIGHTS_STATEMENT_TIMEOUT} (days=${days})`);
        throw new ServiceUnavailableException({ code: 'INSIGHTS_TIMEOUT', message: 'Insights query took too long; try a shorter range' });
      }
      if (state === '22023') throw new BadRequestException({ code: 'INSIGHTS_INVALID', message: 'tz is not supported by the database', details: { field: 'tz' } });
      throw error;
    }
  }

  private available(metric: InsightMetric, present: Set<string>) { return METRIC_TABLES[metric].every(table => present.has(table)); }

  private async buildSummary(tx: ApplicationTransaction, range: InsightRange, window: InsightWindow, present: Set<string>): Promise<InsightSummary> {
    const ok = (metric: InsightMetric) => this.available(metric, present);
    const money = async (metric: InsightMetric) => ok(metric)
      ? { available: true as const, totals: (await additiveTotals(tx, metric, window)).map(row => ({ currency: row.key, amount: row.value })) }
      : UNAVAILABLE;
    const total = async (metric: InsightMetric) => ok(metric)
      ? { available: true as const, value: (await additiveTotals(tx, metric, window)).reduce((sum, row) => sum + numeric(row.value), 0) }
      : UNAVAILABLE;
    // One transaction, one connection: statements run one after another.
    const revenue = await money('revenue');
    const refunds = await money('refunds');
    const newUsers = await total('new-users');
    const payingUsers = ok('paying-users') ? { available: true as const, value: await payersTotal(tx, window) } : UNAVAILABLE;
    const active = ok('active-subscriptions')
      ? await activeSubscriptions(tx, window.asOf).then(value => ({ available: true as const, value: value.plans, provider: value.provider }))
      : UNAVAILABLE;
    const granted = await total('credits-granted');
    const consumed = await total('credits-consumed');
    const aiTasks = ok('ai-tasks')
      ? await aiTaskBreakdown(tx, window).then(breakdown => ({ available: true as const, value: breakdown.reduce((sum, row) => sum + row.count, 0), breakdown }))
      : UNAVAILABLE;
    const chat = await total('chat-messages');
    const sources = ok('signups-by-source') ? { available: true as const, ...(await signupSources(tx, window)) } : UNAVAILABLE;
    return { range, metrics: { revenue, refunds, 'new-users': newUsers, 'paying-users': payingUsers, 'active-subscriptions': active,
      'credits-granted': granted, 'credits-consumed': consumed, 'ai-tasks': aiTasks, 'chat-messages': chat, 'signups-by-source': sources } };
  }

  private async buildSeries(tx: ApplicationTransaction, metric: InsightMetric, range: InsightRange, window: InsightWindow,
    present: Set<string>, dates: string[]): Promise<InsightSeries> {
    const head = { metric, range, unit: METRIC_UNITS[metric] };
    if (!this.available(metric, present)) return { ...head, available: false };
    if (metric === 'active-subscriptions') {
      const value = await activeSubscriptions(tx, window.asOf);
      return { ...head, available: true, kind: 'point', value: value.plans, provider: value.provider };
    }
    if (metric === 'signups-by-source') {
      const sources = await signupSources(tx, window);
      return { ...head, available: true, kind: 'ranking', items: sources.items.map(row => ({ key: row.source, value: row.count })), unattributed: sources.unattributed };
    }
    const rows = metric === 'paying-users' ? await payersDaily(tx, window) : isAdditive(metric) ? await additiveDaily(tx, metric, window) : [];
    return { ...head, available: true, kind: 'daily', series: zeroFill(rows, dates, FIXED_KEYS[metric] ?? [], METRIC_UNITS[metric] === 'money', metric === 'paying-users') };
  }
}

/**
 * One point per local day for every key (currency, status or `total`); missing days are zero. Money
 * stays a decimal string and is never added across currencies. `paying-users` has no `total` (a
 * distinct count is not the sum of daily distinct counts; the summary carries the window value).
 */
function zeroFill(rows: DailyValue[], dates: string[], fixed: readonly string[], money: boolean, distinct: boolean): DailySeries[] {
  const keys = [...new Set([...fixed, ...rows.map(row => row.key)])];
  const byKey = new Map(keys.map(key => [key, new Map<string, string>()]));
  for (const row of rows) byKey.get(row.key)!.set(row.day, row.value);
  return keys.map(key => {
    const values = byKey.get(key)!;
    if (money) {
      const points = dates.map(date => ({ date, value: values.get(date) ?? '0' }));
      return { key, total: sumDecimal(points.map(point => point.value)), points };
    }
    const points = dates.map(date => ({ date, value: numeric(values.get(date) ?? '0') }));
    return distinct ? { key, points } : { key, total: points.reduce((sum, point) => sum + point.value, 0), points };
  });
}

/** Exact decimal addition of non-negative decimal strings (one currency), keeping the widest scale. */
export function sumDecimal(values: readonly string[]): string {
  let scale = 0;
  for (const value of values) scale = Math.max(scale, value.split('.')[1]?.length ?? 0);
  let total = 0n;
  for (const value of values) {
    const [whole, fraction = ''] = value.split('.');
    total += BigInt(whole! + fraction.padEnd(scale, '0'));
  }
  if (!scale) return total.toString();
  const digits = total.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

