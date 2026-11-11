import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { PostgresTaskRepository, type DurableTaskAttemptContext } from '@zucker-framework/task';
import { CHECKOUT_FULFILLED_OUTBOX_KIND } from '../billing/checkout-persistence';
import { ApplicationDatabase } from '../database';
import { JobsService } from '../jobs/jobs.service';
import { MAIL_TEMPLATE_KEYS, mailLocale } from './mail-templates';
import { TransactionalMail } from './transactional-mail';

export const BILLING_RECEIPT_JOB = 'mail.billing-receipt';
/** Fulfillments older than this are never mailed, so enabling mail on an old installation sends no backlog. */
export const RECEIPT_WINDOW_MS = 3 * 86_400_000;
const SCAN_LIMIT = 50;

interface ReceiptOrder {
  id: string; ownerId: string; fulfilledAt: Date | null;
  offer: { description?: unknown; money?: ReceiptMoney; promotion?: { payable?: ReceiptMoney; discount?: ReceiptMoney } | null } | null;
}
interface ReceiptMoney { amount?: unknown; currency?: unknown }
const moneyText = (money: ReceiptMoney | undefined) => typeof money?.amount === 'string' && typeof money.currency === 'string'
  ? `${money.amount} ${money.currency}` : '';
interface ReceiptOwner { email: string | null; emailVerified: boolean; status: boolean; locale: string | null; name: string | null }
type ReceiptOutcome = { orderId: string; sent: boolean; reason?: 'already-sent' | 'mail-disabled' | 'no-recipient' | 'not-fulfilled' };

/**
 * Best-effort receipt mail, consumer of the existing `billing.credit-fulfilled` outbox rows (written
 * in the fulfillment transaction). The billing outbox row itself is left untouched: a wake source
 * submits one `mail.billing-receipt` job per order (job identity = order id), and the job sends one
 * `billing.receipt` mail to the owner's verified address. A successful send recorded in `email_logs`
 * for the order suppresses a resend when an attempt is retried after delivery. Delivery failures retry
 * up to the job's attempt limit and then stay a failed task; they never affect the payment.
 */
@Injectable()
export class BillingReceiptMail implements OnModuleInit {
  private readonly logger = new Logger(BillingReceiptMail.name);
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly mail: TransactionalMail,
    @Optional() private readonly jobs?: JobsService) {}

  onModuleInit(): void {
    if (!this.jobs) return;
    this.jobs.registerHandler({ kind: BILLING_RECEIPT_JOB, version: '1', maxAttempts: 3, handler: {
      execute: async context => {
        await context.assertActive();
        return this.deliver(this.identity(context));
      },
      complete: (context, result) => this.database.transaction(async tx => !!await new PostgresTaskRepository(tx).transition({
        id: context.task.id, from: 'PROCESSING', to: 'COMPLETED', leaseToken: context.leaseToken, result, now: context.now() })),
    } });
    this.jobs.registerWakeSource({ name: 'billing-receipt-mail', runOnce: async () => { await this.scheduleDue(); } });
  }

  private identity(context: DurableTaskAttemptContext): string {
    const payload = context.task.payload as { orderId?: unknown } | null;
    if (!payload || typeof payload.orderId !== 'string' || context.task.resource.type !== 'billing-order'
      || context.task.resource.id !== payload.orderId) throw new Error('Invalid receipt task identity');
    return payload.orderId;
  }

  /** Queues a receipt job for each recent fulfillment that has none yet. */
  async scheduleDue(now = new Date()): Promise<number> {
    // Without a transport nothing is queued; fulfillments inside the window are picked up once mail is configured.
    if (!this.jobs || !this.mail.isEnabled()) return 0;
    const due = await this.database.transaction(tx => tx.query<{ orderId: string; ownerId: string }>(`
      SELECT outbox."aggregateId" AS "orderId", orders."ownerId" AS "ownerId" FROM billing_outbox AS outbox
      JOIN billing_orders AS orders ON orders.id = outbox."aggregateId"
      WHERE outbox.kind = $1 AND outbox."createdAt" > $2
        AND NOT EXISTS (SELECT 1 FROM async_jobs AS job WHERE job.kind = $3 AND job."resourceType" = 'billing-order' AND job."resourceId" = outbox."aggregateId")
      ORDER BY outbox."createdAt", outbox.id LIMIT ${SCAN_LIMIT}`, [CHECKOUT_FULFILLED_OUTBOX_KIND, new Date(now.getTime() - RECEIPT_WINDOW_MS), BILLING_RECEIPT_JOB]));
    for (const row of due.rows) {
      await this.jobs.submit({ kind: BILLING_RECEIPT_JOB, idempotencyKey: `receipt:${row.orderId}`, ownerId: row.ownerId,
        orderId: row.orderId, resource: { type: 'billing-order', id: row.orderId }, payload: { orderId: row.orderId } });
    }
    return due.rows.length;
  }

  /** Sends the receipt for one fulfilled order unless it was already sent; throws on delivery failure (retry). */
  async deliver(orderId: string): Promise<ReceiptOutcome> {
    const loaded = await this.database.transaction(async tx => {
      const order = await tx.model('billingOrders').findUnique({ where: { id: orderId },
        select: { id: true, ownerId: true, fulfilledAt: true, offer: true } }) as ReceiptOrder | null;
      if (!order?.fulfilledAt) return null;
      // Sequential: one interactive transaction runs one statement at a time.
      const owner = await tx.model('users').findUnique({ where: { id: order.ownerId },
        select: { email: true, emailVerified: true, status: true, locale: true, name: true } }) as ReceiptOwner | null;
      const fulfillment = await tx.model('billingFulfillments').findUnique({ where: { orderId }, select: { credits: true } }) as { credits: number } | null;
      const sent = await tx.query<{ found: number }>(`SELECT 1 AS found FROM email_logs WHERE template = $1 AND status = 'success' AND metadata->>'orderId' = $2 LIMIT 1`,
        [MAIL_TEMPLATE_KEYS.receipt, orderId]);
      return { order, owner, credits: fulfillment?.credits ?? 0, alreadySent: sent.rows.length > 0 };
    });
    if (!loaded) return { orderId, sent: false, reason: 'not-fulfilled' };
    if (loaded.alreadySent) return { orderId, sent: false, reason: 'already-sent' };
    const { order, owner } = loaded;
    if (!owner?.status || !owner.emailVerified || !owner.email) return { orderId, sent: false, reason: 'no-recipient' };
    if (!this.mail.isEnabled()) return { orderId, sent: false, reason: 'mail-disabled' };
    // The receipt states what was charged: the frozen payable after a promotion, never the list price.
    const promotion = order.offer?.promotion ?? null;
    const money = promotion?.payable ?? order.offer?.money;
    const discount = promotion ? moneyText(promotion.discount) : '';
    const result = await this.mail.send(MAIL_TEMPLATE_KEYS.receipt, {
      to: owner.email, locale: owner.locale, userId: order.ownerId,
      data: {
        name: owner.name ?? '', orderId: order.id,
        description: typeof order.offer?.description === 'string' ? order.offer.description.slice(0, 200) : '',
        amount: typeof money?.amount === 'string' ? money.amount : '', currency: typeof money?.currency === 'string' ? money.currency : '',
        // "-5.00 USD (list price 20.00 USD)" for a discounted order, "—" otherwise.
        discount: discount ? `-${discount} (${mailLocale(owner.locale) === 'zh' ? '原价' : 'list price'} ${moneyText(order.offer?.money)})` : '—',
        credits: loaded.credits, paidAt: `${order.fulfilledAt!.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        link: this.mail.link(owner.locale, '/billing/orders'),
      },
      logMetadata: { orderId: order.id },
    });
    if (!result.success) {
      this.logger.warn(`Receipt mail for an order failed (${result.errorCode ?? 'delivery'}); the job will retry`);
      throw new Error('Receipt mail delivery failed');
    }
    return { orderId, sent: true };
  }
}
