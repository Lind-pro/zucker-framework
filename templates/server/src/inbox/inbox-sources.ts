import type { ApplicationTransaction } from '../database';
import { INBOX_MAX_COUNT, type InboxEmitInput } from './inbox-types';

/** Scan position: timestamp and id of the last consumed source row (strict `>` on the pair). */
export interface InboxCursor { at: Date; id: string }

/** One source row; `notification` null means "consume without notifying" (the cursor still moves). */
export interface InboxSourceEvent { cursor: InboxCursor; notification: InboxEmitInput | null }

export interface InboxSource {
  /** Cursor row id (`inbox_cursors.source`), stable forever. */
  name: string;
  /** Tables the scan reads; a source with a missing table is skipped with one warning. */
  tables: readonly string[];
  /**
   * Committed rows after `cursor` whose timestamp is not later than `settledBefore`, oldest first,
   * at most `limit`. `settledBefore` trails the clock by more than the longest transaction, so a row
   * whose transaction commits late still gets a timestamp after the cursor when it becomes visible.
   */
  scan(tx: ApplicationTransaction, cursor: InboxCursor, limit: number, settledBefore: Date): Promise<InboxSourceEvent[]>;
}

export function defineInboxSource(source: InboxSource): InboxSource {
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(source.name)) throw new Error(`Invalid inbox source name ${source.name}`);
  if (!source.tables.length || source.tables.some(table => !/^[a-z_][a-z0-9_]{0,62}$/.test(table)))
    throw new Error(`Inbox source ${source.name} needs valid table names`);
  return Object.freeze({ ...source, tables: Object.freeze([...source.tables]) });
}

interface OutboxRow { at: Date; id: string; aggregateId: string; ownerId: string; credits: unknown; extra: string | null; initialOrderId: string | null }
// Same bound as validateInboxEmit: an implausible stored amount is announced without a number (0), never a poison row.
const credits = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= INBOX_MAX_COUNT ? value : 0);
const asDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/**
 * `billing_outbox."createdAt"` is `timestamp without time zone` written in UTC (sessions are pinned
 * to UTC), so cursor bounds are converted with `AT TIME ZONE 'UTC'` and returned as instants.
 * The owner always comes from the business row, never from the outbox payload alone.
 */
function outboxScan(kind: string, select: string, join: string) {
  return async (tx: ApplicationTransaction, cursor: InboxCursor, limit: number, settledBefore: Date) => {
    const result = await tx.query<OutboxRow>(`
      SELECT outbox."createdAt" AT TIME ZONE 'UTC' AS at, outbox.id, outbox."aggregateId" AS "aggregateId", ${select}
      FROM billing_outbox AS outbox ${join}
      WHERE outbox.kind = $1
        AND (outbox."createdAt", outbox.id) > ($2::timestamptz AT TIME ZONE 'UTC', $3)
        AND outbox."createdAt" <= $4::timestamptz AT TIME ZONE 'UTC'
      ORDER BY outbox."createdAt", outbox.id
      LIMIT ${Math.trunc(limit)}`, [kind, cursor.at.toISOString(), cursor.id, settledBefore.toISOString()]);
    return result.rows.map(row => ({ ...row, at: asDate(row.at) }));
  };
}

const orderPaid = outboxScan('billing.credit-fulfilled',
  `orders."ownerId" AS "ownerId", outbox.payload->'credits' AS credits, NULL AS extra, NULL AS "initialOrderId"`,
  'JOIN billing_orders AS orders ON orders.id = outbox."aggregateId"');
const cycleFulfilled = outboxScan('billing.subscription-credit-fulfilled',
  `cycles."ownerId" AS "ownerId", outbox.payload->'credits' AS credits, NULL AS extra,
   CASE WHEN cycles.initial THEN subscriptions."initialOrderId" END AS "initialOrderId"`,
  `JOIN billing_subscription_cycles AS cycles ON cycles.id = outbox."aggregateId"
   JOIN billing_subscriptions AS subscriptions ON subscriptions.id = cycles."bindingId"`);
const refundSettled = outboxScan('billing.refund-settled',
  `requests."ownerId" AS "ownerId", NULL::jsonb AS credits, requests.state AS extra, NULL AS "initialOrderId"`,
  'JOIN billing_refund_requests AS requests ON requests.id = outbox."aggregateId"');

/** Built-in sources: committed billing outbox rows and finished AI tasks. Billing/AI code is untouched. */
export const INBOX_SOURCES: readonly InboxSource[] = Object.freeze([
  defineInboxSource({
    name: 'billing.order-paid', tables: ['billing_outbox', 'billing_orders'],
    scan: async (...args) => (await orderPaid(...args)).map(row => ({ cursor: { at: row.at, id: row.id }, notification: {
      userId: row.ownerId, eventKey: `order:${row.aggregateId}`, type: 'order.paid', params: { credits: credits(row.credits) }, href: '/billing/orders' } })),
  }),
  defineInboxSource({
    name: 'billing.subscription-cycle', tables: ['billing_outbox', 'billing_subscription_cycles', 'billing_subscriptions'],
    // The first cycle is the purchase itself: it is announced as that order's `order.paid` (same key as
    // the checkout source, so a purchase is never announced twice); later cycles are renewals.
    scan: async (...args) => (await cycleFulfilled(...args)).map(row => ({ cursor: { at: row.at, id: row.id }, notification: row.initialOrderId
      ? { userId: row.ownerId, eventKey: `order:${row.initialOrderId}`, type: 'order.paid', params: { credits: credits(row.credits) }, href: '/billing/orders' }
      : { userId: row.ownerId, eventKey: `cycle:${row.aggregateId}`, type: 'subscription.renewed', params: { credits: credits(row.credits) }, href: '/billing/subscriptions' } })),
  }),
  defineInboxSource({
    name: 'billing.refund-settled', tables: ['billing_outbox', 'billing_refund_requests'],
    // Only a successful refund concerns the customer; failed or cancelled staff attempts are not announced.
    scan: async (tx, cursor, limit, settledBefore) => {
      const rows = await refundSettled(tx, cursor, limit, settledBefore);
      return rows.map(row => ({ cursor: { at: row.at, id: row.id }, notification: row.extra === 'succeeded'
        ? { userId: row.ownerId, eventKey: `refund:${row.aggregateId}`, type: 'refund.settled', params: { outcome: 'succeeded' }, href: '/billing/orders' }
        : null }));
    },
  }),
  defineInboxSource({
    name: 'ai.tasks', tables: ['ai_tasks', 'async_jobs'],
    scan: async (tx, cursor, limit, settledBefore) => {
      const result = await tx.query<{ at: Date | string; id: string; ownerId: string; kind: string; status: string }>(`
        SELECT jobs."completedAt" AS at, tasks.id, tasks."ownerId" AS "ownerId", tasks.kind, jobs.status::text AS status
        FROM ai_tasks AS tasks JOIN async_jobs AS jobs ON jobs.id = tasks.id
        WHERE jobs.status IN ('COMPLETED', 'FAILED') AND jobs."completedAt" IS NOT NULL
          AND (jobs."completedAt", jobs.id) > ($1::timestamptz, $2)
          AND jobs."completedAt" <= $3::timestamptz
        ORDER BY jobs."completedAt", jobs.id
        LIMIT ${Math.trunc(limit)}`, [cursor.at.toISOString(), cursor.id, settledBefore.toISOString()]);
      return result.rows.map(row => ({ cursor: { at: asDate(row.at), id: row.id }, notification: {
        userId: row.ownerId, eventKey: `ai-task:${row.id}`, type: row.status === 'COMPLETED' ? 'ai.task.completed' : 'ai.task.failed',
        params: { kind: row.kind }, href: '/account/tasks' } satisfies InboxEmitInput }));
    },
  }),
]);
