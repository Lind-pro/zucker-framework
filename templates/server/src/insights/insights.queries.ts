import type { ApplicationTransaction } from '../database';
import type { InsightMetric } from './insights.validation';

/**
 * Read-only aggregate SQL behind the insights endpoints. Every statement is fixed text with bound
 * parameters: `$1`/`$2` are the window bounds (timestamptz, start inclusive, end exclusive) and `$3`
 * is the validated IANA zone used to put each row on a local calendar day. Every row source filters
 * on its timestamp column first, so no query reads outside the window. Rows never carry user ids,
 * emails or IPs out of the database: only counts, sums and day/currency/status keys are selected.
 *
 * Timestamp columns are a mix of `timestamp` (UTC by convention) and `timestamptz`; the application
 * transaction pins `TimeZone=UTC`, so `col::timestamptz` is correct for both.
 */

export interface InsightWindow { from: string; to: string; tz: string; asOf: string }

/** Money as stored in orders/cycles/refunds: `{ amount: "29.00", currency: "USD" }`. Bad rows are ignored, never cast. */
const MONEY_ROWS = (source: string) => `SELECT at, money->>'currency' AS key,
    CASE WHEN money->>'amount' ~ '^[0-9]{1,15}(\\.[0-9]{1,6})?$' THEN (money->>'amount')::numeric END AS amount
  FROM (${source}) AS money_rows
  WHERE jsonb_typeof(money) = 'object' AND money->>'currency' ~ '^[A-Z]{3}$' AND money->>'amount' ~ '^[0-9]{1,15}(\\.[0-9]{1,6})?$'`;

/**
 * Gross revenue: one-time orders on the day they were fulfilled (amount actually due after any
 * promotion), plus every subscription cycle receipt on its paid day. Subscription orders are
 * excluded because their first payment is also recorded as the initial cycle receipt.
 */
const REVENUE_SOURCE = MONEY_ROWS(`
  SELECT o."fulfilledAt" AS at, COALESCE(o.offer->'promotion'->'payable', o.offer->'money') AS money
    FROM billing_orders AS o
   WHERE o."fulfilledAt" >= $1::timestamptz AND o."fulfilledAt" < $2::timestamptz
     AND o.state = 'paid' AND COALESCE(o.offer->>'mode', '') <> 'subscription'
  UNION ALL
  SELECT c."paidAt" AS at, c."paidMoney" AS money
    FROM billing_subscription_cycles AS c
   WHERE c."paidAt" >= $1::timestamptz AND c."paidAt" < $2::timestamptz`);

/** Provider-confirmed refunds on the day they happened (receipt creation when the provider gave no time). */
const REFUND_SOURCE = MONEY_ROWS(`
  SELECT COALESCE(r."occurredAt", r."createdAt") AS at, r.money
    FROM billing_refund_receipts AS r
   WHERE r.state = 'succeeded'
     AND COALESCE(r."occurredAt", r."createdAt") >= $1::timestamptz AND COALESCE(r."occurredAt", r."createdAt") < $2::timestamptz`);

/** Owners with a revenue event (same definition as revenue). */
const PAYER_SOURCE = `
  SELECT o."fulfilledAt" AS at, o."ownerId" AS owner FROM billing_orders AS o
   WHERE o."fulfilledAt" >= $1::timestamptz AND o."fulfilledAt" < $2::timestamptz
     AND o.state = 'paid' AND COALESCE(o.offer->>'mode', '') <> 'subscription'
  UNION ALL
  SELECT c."paidAt" AS at, c."ownerId" AS owner FROM billing_subscription_cycles AS c
   WHERE c."paidAt" >= $1::timestamptz AND c."paidAt" < $2::timestamptz`;

/** Terminal job status of an AI task; anything else is still running. */
const AI_STATUS = `CASE WHEN j.status::text IN ('COMPLETED','FAILED','CANCELLED') THEN lower(j.status::text) ELSE 'in_progress' END`;

/** Row sources of the additive daily metrics: `(at, key, amount)`. */
const ADDITIVE: Partial<Record<InsightMetric, string>> = {
  revenue: REVENUE_SOURCE,
  refunds: REFUND_SOURCE,
  'new-users': `SELECT u."createTime" AS at, 'total' AS key, 1::numeric AS amount FROM users AS u
    WHERE u."createTime" >= $1::timestamptz AND u."createTime" < $2::timestamptz`,
  'credits-granted': `SELECT l."createdAt" AS at, 'total' AS key, l.amount::numeric AS amount FROM credit_lots AS l
    WHERE l."createdAt" >= $1::timestamptz AND l."createdAt" < $2::timestamptz AND l.amount > 0`,
  'credits-consumed': `SELECT c."createdAt" AS at, 'total' AS key, c.amount::numeric AS amount FROM credit_consumptions AS c
    WHERE c."createdAt" >= $1::timestamptz AND c."createdAt" < $2::timestamptz AND c.amount > 0`,
  'ai-tasks': `SELECT t."createdAt" AS at, ${AI_STATUS} AS key, 1::numeric AS amount
    FROM ai_tasks AS t JOIN async_jobs AS j ON j.id = t.id
    WHERE t."createdAt" >= $1::timestamptz AND t."createdAt" < $2::timestamptz`,
  // User turns only: one prompt is one message; assistant rows mirror them.
  'chat-messages': `SELECT m."createdAt" AS at, 'total' AS key, 1::numeric AS amount FROM chat_messages AS m
    WHERE m."createdAt" >= $1::timestamptz AND m."createdAt" < $2::timestamptz AND m.role = 'user'`,
};

/** Tables each metric reads; a missing one (feature not installed) makes the metric unavailable. */
export const METRIC_TABLES: Readonly<Record<InsightMetric, readonly string[]>> = Object.freeze({
  revenue: ['billing_orders', 'billing_subscription_cycles'],
  refunds: ['billing_refund_receipts'],
  'new-users': ['users'],
  'paying-users': ['billing_orders', 'billing_subscription_cycles'],
  'active-subscriptions': ['user_subscriptions', 'billing_subscriptions'],
  'credits-granted': ['credit_lots'],
  'credits-consumed': ['credit_consumptions'],
  'ai-tasks': ['ai_tasks', 'async_jobs'],
  'chat-messages': ['chat_messages'],
  'signups-by-source': ['user_acquisition'],
});

export type InsightUnit = 'money' | 'count' | 'credits';
export const METRIC_UNITS: Readonly<Record<InsightMetric, InsightUnit>> = Object.freeze({
  revenue: 'money', refunds: 'money', 'new-users': 'count', 'paying-users': 'count', 'active-subscriptions': 'count',
  'credits-granted': 'credits', 'credits-consumed': 'credits', 'ai-tasks': 'count', 'chat-messages': 'count', 'signups-by-source': 'count',
});

const params = (window: InsightWindow) => [window.from, window.to, window.tz];
const DAY = (column: string) => `to_char(${column}::timestamptz AT TIME ZONE $3, 'YYYY-MM-DD')`;

/** Which of `tables` exist in the transaction's schema (search_path is pinned by the transaction). */
export async function presentTables(tx: ApplicationTransaction, tables: readonly string[]): Promise<Set<string>> {
  if (!tables.length) return new Set();
  const columns = tables.map((_, index) => `to_regclass($${index + 1}) IS NOT NULL AS "t${index}"`).join(', ');
  const row = (await tx.query<Record<string, boolean>>(`SELECT ${columns}`, [...tables])).rows[0] ?? {};
  return new Set(tables.filter((_, index) => row[`t${index}`] === true));
}

/**
 * Local calendar window ending today (in `tz`, as of `asOf`): `days` local days, start at local
 * midnight, end at the next local midnight. DST days are 23 or 25 hours long; PostgreSQL handles it.
 */
export async function resolveWindow(tx: ApplicationTransaction, days: number, tz: string, asOf: Date) {
  const row = (await tx.query<{ first: string; last: string; from: string; to: string }>(`
    SELECT to_char(d.first, 'YYYY-MM-DD') AS first, to_char(d.last, 'YYYY-MM-DD') AS last,
           to_char((d.first::timestamp AT TIME ZONE $1) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "from",
           to_char(((d.last + 1)::timestamp AT TIME ZONE $1) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "to"
      FROM (SELECT ($3::timestamptz AT TIME ZONE $1)::date - ($2::int - 1) AS first,
                   ($3::timestamptz AT TIME ZONE $1)::date AS last) AS d`, [tz, days, asOf.toISOString()])).rows[0]!;
  const dates = (await tx.query<{ day: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM generate_series($1::date, $2::date, interval '1 day') AS day ORDER BY day`,
    [row.first, row.last])).rows.map(entry => entry.day);
  return { first: row.first, last: row.last, dates, window: { from: row.from, to: row.to, tz, asOf: asOf.toISOString() } };
}

export interface KeyedValue { key: string; value: string }
export interface DailyValue extends KeyedValue { day: string }

/** Per-day, per-key sums of an additive metric. */
export async function additiveDaily(tx: ApplicationTransaction, metric: InsightMetric, window: InsightWindow): Promise<DailyValue[]> {
  const source = ADDITIVE[metric];
  if (!source) throw new Error(`Metric ${metric} is not additive`);
  return (await tx.query<DailyValue>(`SELECT ${DAY('s.at')} AS day, s.key, SUM(s.amount)::text AS value
    FROM (${source}) AS s GROUP BY 1, 2 ORDER BY 1, 2`, params(window))).rows;
}

/** Window totals per key of an additive metric. */
export async function additiveTotals(tx: ApplicationTransaction, metric: InsightMetric, window: InsightWindow): Promise<KeyedValue[]> {
  const source = ADDITIVE[metric];
  if (!source) throw new Error(`Metric ${metric} is not additive`);
  return (await tx.query<KeyedValue>(`SELECT s.key, SUM(s.amount)::text AS value FROM (${source}) AS s GROUP BY 1 ORDER BY 1`, [window.from, window.to])).rows;
}

export const isAdditive = (metric: InsightMetric) => ADDITIVE[metric] !== undefined;

/** AI tasks in the window by kind and status bucket. */
export async function aiTaskBreakdown(tx: ApplicationTransaction, window: InsightWindow) {
  return (await tx.query<{ kind: string; status: string; count: number }>(`SELECT t.kind, ${AI_STATUS} AS status, COUNT(*)::int AS count
    FROM ai_tasks AS t JOIN async_jobs AS j ON j.id = t.id
    WHERE t."createdAt" >= $1::timestamptz AND t."createdAt" < $2::timestamptz
    GROUP BY 1, 2 ORDER BY 1, 2`, [window.from, window.to])).rows;
}

/** Distinct paying users per local day. */
export async function payersDaily(tx: ApplicationTransaction, window: InsightWindow): Promise<DailyValue[]> {
  return (await tx.query<DailyValue>(`SELECT ${DAY('s.at')} AS day, 'total' AS key, COUNT(DISTINCT s.owner)::text AS value
    FROM (${PAYER_SOURCE}) AS s GROUP BY 1 ORDER BY 1`, params(window))).rows;
}

/** Distinct paying users over the whole window (not the sum of the daily counts). */
export async function payersTotal(tx: ApplicationTransaction, window: InsightWindow): Promise<number> {
  const row = (await tx.query<{ value: number }>(`SELECT COUNT(DISTINCT s.owner)::int AS value FROM (${PAYER_SOURCE}) AS s`,
    [window.from, window.to])).rows[0];
  return row?.value ?? 0;
}

/**
 * Active plan terms as of `asOf` (the same predicate as the subscriptions service: ACTIVE or
 * CANCELED-at-period-end terms that started and have not ended; lifetime ACTIVE terms), plus
 * provider-billed subscriptions the provider reports as active or trialing.
 */
export async function activeSubscriptions(tx: ApplicationTransaction, asOf: string) {
  const row = (await tx.query<{ plans: number; provider: number }>(`SELECT
      (SELECT COUNT(*)::int FROM user_subscriptions AS s
        WHERE s.status IN ('ACTIVE','CANCELED') AND s."startDate" <= $1::timestamptz
          AND (s."endDate" > $1::timestamptz OR (s."endDate" IS NULL AND s."billingCycle" = 'LIFETIME' AND s.status = 'ACTIVE'))) AS plans,
      (SELECT COUNT(*)::int FROM billing_subscriptions AS b WHERE b.status IN ('active','trialing')) AS provider`, [asOf])).rows[0];
  return { plans: row?.plans ?? 0, provider: row?.provider ?? 0 };
}

export const SIGNUP_SOURCE_LIMIT = 10;
/** Top sign-up sources (sanitised `signupUtmSource`) in the window and the count without one. */
export async function signupSources(tx: ApplicationTransaction, window: InsightWindow) {
  const top = (await tx.query<{ source: string; count: number }>(`SELECT a."signupUtmSource" AS source, COUNT(*)::int AS count
    FROM user_acquisition AS a
    WHERE a."createdAt" >= $1::timestamptz AND a."createdAt" < $2::timestamptz AND a."signupUtmSource" IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${SIGNUP_SOURCE_LIMIT}`, [window.from, window.to])).rows;
  const totals = (await tx.query<{ attributed: number; unattributed: number }>(`SELECT
      COUNT(*) FILTER (WHERE a."signupUtmSource" IS NOT NULL)::int AS attributed,
      COUNT(*) FILTER (WHERE a."signupUtmSource" IS NULL)::int AS unattributed
    FROM user_acquisition AS a WHERE a."createdAt" >= $1::timestamptz AND a."createdAt" < $2::timestamptz`, [window.from, window.to])).rows[0];
  return { items: top, attributed: totals?.attributed ?? 0, unattributed: totals?.unattributed ?? 0 };
}
