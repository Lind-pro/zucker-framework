import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { PostgresTaskRepository, type DurableTaskAttemptContext } from '@zucker-framework/task';
import { TransactionalMail, deliverBillingReceipt, type ReceiptOutcome } from '@zucker-framework/back-office/mail';
import { CHECKOUT_FULFILLED_OUTBOX_KIND } from '../billing/checkout-persistence';
import { ApplicationDatabase } from '../database';
import { JobsService } from '../jobs/jobs.service';

export const BILLING_RECEIPT_JOB = 'mail.billing-receipt';
/** Fulfillments older than this are never mailed, so enabling mail on an old installation sends no backlog. */
export const RECEIPT_WINDOW_MS = 3 * 86_400_000;
const SCAN_LIMIT = 50;

/**
 * Best-effort receipt mail, consumer of the existing `billing.credit-fulfilled` outbox rows (written
 * in the fulfillment transaction). The billing outbox row itself is left untouched: a wake source
 * submits one `mail.billing-receipt` job per order (job identity = order id), and the job sends one
 * `billing.receipt` mail (`deliverBillingReceipt`, back-office mail host) to the owner's verified
 * address. A successful send recorded in `email_logs` for the order suppresses a resend when an attempt
 * is retried after delivery. Delivery failures retry up to the job's attempt limit and then stay a
 * failed task; they never affect the payment.
 */
@Injectable()
export class BillingReceiptMail implements OnModuleInit {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, @Inject(TransactionalMail) private readonly mail: TransactionalMail,
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
  deliver(orderId: string): Promise<ReceiptOutcome> {
    return deliverBillingReceipt(this.database, this.mail, orderId);
  }
}
