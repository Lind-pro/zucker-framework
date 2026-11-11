import { Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { MAIL_TEMPLATE_KEYS } from './mail-templates';
import { TransactionalMail } from './transactional-mail';

interface ReceiptMoney { amount?: unknown; currency?: unknown }
interface ReceiptOrder {
  id: string; ownerId: string; fulfilledAt: Date | null;
  offer: { description?: unknown; money?: ReceiptMoney; promotion?: { payable?: ReceiptMoney; discount?: ReceiptMoney } | null } | null;
}
interface ReceiptOwner { email: string | null; emailVerified: boolean; status: boolean; locale: string | null; name: string | null }
export type ReceiptOutcome = { orderId: string; sent: boolean; reason?: 'already-sent' | 'mail-disabled' | 'no-recipient' | 'not-fulfilled' };

const moneyText = (money: ReceiptMoney | undefined) => typeof money?.amount === 'string' && typeof money.currency === 'string'
  ? `${money.amount} ${money.currency}` : '';
function requireFindFirst(tx: DatabaseAdapter, model: string) {
  const operations = tx.model(model);
  if (!operations.findFirst) throw new Error('[back-office/mail] receipts need query(sql) or findFirst on the mail log model');
  return operations.findFirst.bind(operations);
}
type SqlCapable = DatabaseAdapter & { query?: <T>(sql: string, values?: readonly unknown[]) => Promise<{ rows: T[] }> };

/**
 * Sends one `billing.receipt` mail for a fulfilled order to the owner's verified address, unless a
 * successful send for that order is already in the mail log. The receipt states what was charged:
 * the frozen promotion payable (with the discount and list price), never the list price alone.
 * Throws on delivery failure so a job runner retries; never affects the payment.
 * `credits` is the fulfillment's credit grant (`null` when the consumer has no fulfillment model).
 */
export async function deliverBillingReceipt(database: DatabaseAdapter, mail: TransactionalMail, orderId: string,
  options: { credits?: boolean } = {}): Promise<ReceiptOutcome> {
  const { models, tables, links } = mail.options;
  const loaded = await database.$transaction(async (tx) => {
    const order = await tx.model(models.billingOrders).findUnique({ where: { id: orderId },
      select: { id: true, ownerId: true, fulfilledAt: true, offer: true } }) as ReceiptOrder | null;
    if (!order?.fulfilledAt) return null;
    // Sequential: one interactive transaction runs one statement at a time.
    const owner = await tx.model(models.users).findUnique({ where: { id: order.ownerId },
      select: { email: true, emailVerified: true, status: true, locale: true, name: true } }) as ReceiptOwner | null;
    const fulfillment = options.credits === false ? null
      : await tx.model(models.billingFulfillments).findUnique({ where: { orderId }, select: { credits: true } }) as { credits: number } | null;
    const sql = tx as SqlCapable;
    const alreadySent = typeof sql.query === 'function'
      ? (await sql.query<{ found: number }>(`SELECT 1 AS found FROM "${tables.emailLogs}" WHERE template = $1 AND status = 'success' AND metadata->>'orderId' = $2 LIMIT 1`,
        [MAIL_TEMPLATE_KEYS.receipt, orderId])).rows.length > 0
      : !!await requireFindFirst(tx, models.emailLogs)({ where: { template: MAIL_TEMPLATE_KEYS.receipt, status: 'success', metadata: { path: ['orderId'], equals: orderId } },
        select: { id: true } });
    return { order, owner, credits: fulfillment?.credits ?? 0, alreadySent };
  });
  if (!loaded) return { orderId, sent: false, reason: 'not-fulfilled' };
  if (loaded.alreadySent) return { orderId, sent: false, reason: 'already-sent' };
  const { order, owner } = loaded;
  if (!owner?.status || !owner.emailVerified || !owner.email) return { orderId, sent: false, reason: 'no-recipient' };
  if (!mail.isEnabled()) return { orderId, sent: false, reason: 'mail-disabled' };
  const promotion = order.offer?.promotion ?? null;
  const money = promotion?.payable ?? order.offer?.money;
  const discount = promotion ? moneyText(promotion.discount) : '';
  const result = await mail.send(MAIL_TEMPLATE_KEYS.receipt, {
    to: owner.email, locale: owner.locale, userId: order.ownerId,
    data: {
      name: owner.name ?? '', orderId: order.id,
      description: typeof order.offer?.description === 'string' ? order.offer.description.slice(0, 200) : '',
      amount: typeof money?.amount === 'string' ? money.amount : '', currency: typeof money?.currency === 'string' ? money.currency : '',
      // "-5.00 USD (list price 20.00 USD)" for a discounted order, "—" otherwise.
      discount: discount ? `-${discount} (${mail.locale(owner.locale) === 'zh' ? '原价' : 'list price'} ${moneyText(order.offer?.money)})` : '—',
      credits: options.credits === false ? '—' : loaded.credits,
      paidAt: `${order.fulfilledAt!.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      link: mail.link(owner.locale, links.receipt),
    },
    logMetadata: { orderId: order.id },
  });
  if (!result.success) {
    new Logger('BillingReceiptMail').warn(`Receipt mail for an order failed (${result.errorCode ?? 'delivery'}); the job will retry`);
    throw new Error('Receipt mail delivery failed');
  }
  return { orderId, sent: true };
}

/** Injectable form of `deliverBillingReceipt` (feature `receipts`); the consumer's job runner calls `deliver`. */
@Injectable()
export class BillingReceiptMailer {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: DatabaseAdapter, @Inject(TransactionalMail) private readonly mail: TransactionalMail) {}
  deliver(orderId: string, options?: { credits?: boolean }): Promise<ReceiptOutcome> {
    return deliverBillingReceipt(this.database, this.mail, orderId, options);
  }
}
