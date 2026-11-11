import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Inject, Logger, NotFoundException, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Public } from '@zucker-framework/auth';
import { HostedCheckoutError, RefundProtocolError, SubscriptionProtocolError, type HostedCheckoutPromotionQuote, type Money } from '@zucker-framework/payment';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { BILLING_OPTIONS, BillingService, type BillingOptionsSource } from '../billing.service';
import { BILLING_WEBHOOK_LIMITER } from '../../rate-limits';
import {
  findFakePaymentLedger, isFakeCheckoutId, isFakeRefundId, isFakeSubscriptionId, parseFakeMoney,
  type FakeCheckoutEvidence, type FakePaymentLedger, type FakeSignedWebhook,
} from './fake-payment-provider';
import { assertNotProduction, FAKE_PAYMENT_PROVIDER_ID } from './switch';

interface PageResponse {
  setHeader(name: string, value: string): void;
  status(code: number): PageResponse;
  type(value: string): PageResponse;
  send(body: string): void;
  redirect(status: number, url: string): void;
}

const PAGE_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1f2328}'
  + '.note{font-size:.8rem;color:#9a6700}form{display:inline-block;margin-right:.5rem}button{font:inherit;padding:.5rem 1rem;cursor:pointer}';
const STYLE_HASH = `'sha256-${createHash('sha256').update(PAGE_STYLE).digest('base64')}'`;
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const show = (money: Money) => `${escape(money.amount)} ${escape(money.currency)}`;

function record(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)))
    throw new BadRequestException(`Body may contain only: ${allowed.join(', ')}`);
  return body as Record<string, unknown>;
}
function money(value: unknown, label: string): Money {
  try { return parseFakeMoney(value, label); } catch (error) { throw new BadRequestException((error as Error).message); }
}

/**
 * TEST-ONLY hosted checkout of the `fake` provider, mounted only when `BILLING_TEST_FAKE_PROVIDER=true`
 * (see `billingTestFakeControllers`) and refused when `NODE_ENV=production`. All routes are public,
 * as a real provider's page is. Redirect targets come from the order the fake was created with,
 * never from the request; webhooks go through the application's own verification (`BillingService.webhook`).
 *
 * - `GET  :checkoutId`            hosted page (no script, strict CSP): description and amounts, Pay / Cancel.
 * - `POST :checkoutId/pay`        pays, sends the signed `checkout.completed` webhook in process (skip with
 *                                 `?webhook=skip`) and redirects (303) to the order's success URL.
 * - `POST :checkoutId/cancel`     redirects (303) to the order's cancel URL; the checkout stays pending.
 * - `POST :checkoutId/webhook`    sends the signed webhook again; returns it so a test can replay it to
 *                                 `/api/billing/webhooks/fake`.
 * - `POST :checkoutId/promo`      before payment: `{paidMoney?, subtotalMoney?, discountMoney?, discountReferences?}`
 *                                 overrides the evidence the provider will report (promotion and mismatch tests).
 * - `POST promotions`             `{providerCode, discount: Money | null, duration?}` declares what the provider's
 *                                 promotion would discount (`discount: null` = provider cannot tell).
 * - `POST renew/:subscriptionId`  next paid period at the list price, plus the signed `subscription.updated` webhook.
 * - `POST refunds/mode`           `{state: 'pending' | 'succeeded' | 'failed'}` for refunds created afterwards.
 * - `POST refunds/:refundId/settle` `{state: 'succeeded' | 'failed' | 'canceled'}` plus the signed `refund.updated` webhook.
 */
@Controller('billing/test-checkout')
@UseGuards(RateLimitGuard)
@RateLimit(BILLING_WEBHOOK_LIMITER)
export class FakeCheckoutController {
  private readonly logger = new Logger('FakePaymentProvider');
  constructor(private readonly billing: BillingService, @Inject(BILLING_OPTIONS) private readonly options: BillingOptionsSource) {
    assertNotProduction(process.env);
  }

  private ledger(): FakePaymentLedger {
    const options = typeof this.options === 'function' ? this.options() : this.options;
    const ledger = findFakePaymentLedger(options.providers);
    if (!ledger) throw new NotFoundException();
    return ledger;
  }
  private async run<T>(work: (ledger: FakePaymentLedger) => T | Promise<T>): Promise<T> {
    const ledger = this.ledger();
    try { return await work(ledger); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof HostedCheckoutError) throw new HttpException({ code: error.code, message: error.message }, error.code === 'not_found' ? 404 : 409);
      if (error instanceof RefundProtocolError || error instanceof SubscriptionProtocolError) throw new HttpException({ code: error.code, message: error.message }, 409);
      throw error;
    }
  }
  private checkoutId(value: string): string {
    if (!isFakeCheckoutId(value)) throw new NotFoundException();
    return value;
  }
  /** Delivers like a provider would: through the application's verification. A failure is reported, not thrown. */
  private async deliver(webhook: FakeSignedWebhook): Promise<{ delivered: boolean; error?: string; request: { body: string; headers: Record<string, string> } }> {
    try {
      await this.billing.webhook(FAKE_PAYMENT_PROVIDER_ID, { rawBody: Buffer.from(webhook.rawBody), headers: webhook.headers });
      return { delivered: true, request: { body: webhook.rawBody, headers: webhook.headers } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Webhook delivery failed';
      this.logger.warn(`Fake webhook was not accepted: ${message}`);
      return { delivered: false, error: message, request: { body: webhook.rawBody, headers: webhook.headers } };
    }
  }
  private noStore(res: PageResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  @Post('promotions') @Public() @HttpCode(200)
  promotion(@Body() body: unknown) {
    const input = record(body, ['providerCode', 'discount', 'duration']);
    const code = input.providerCode;
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(code)) throw new BadRequestException('providerCode is required');
    const duration = input.duration ?? 'once';
    if (!['once', 'repeating', 'forever'].includes(duration as string)) throw new BadRequestException('duration must be once, repeating or forever');
    const quote: HostedCheckoutPromotionQuote | null = input.discount === null ? null
      : { discount: money(input.discount, 'discount'), duration: duration as HostedCheckoutPromotionQuote['duration'] };
    return this.run(ledger => { ledger.declarePromotion(code, quote); return { providerCode: code, quote }; });
  }

  @Post('refunds/mode') @Public() @HttpCode(200)
  refundMode(@Body() body: unknown) {
    const { state } = record(body, ['state']);
    if (state !== 'pending' && state !== 'succeeded' && state !== 'failed') throw new BadRequestException('state must be pending, succeeded or failed');
    return this.run(ledger => { ledger.setRefundMode(state); return { state }; });
  }

  @Post('refunds/:refundId/settle') @Public() @HttpCode(200)
  settle(@Param('refundId') refundId: string, @Body() body: unknown) {
    if (!isFakeRefundId(refundId)) throw new NotFoundException();
    const { state } = record(body, ['state']);
    if (state !== 'succeeded' && state !== 'failed' && state !== 'canceled') throw new BadRequestException('state must be succeeded, failed or canceled');
    return this.run(async ledger => {
      const refund = ledger.settleRefund(refundId, state);
      return { refund, webhook: await this.deliver(ledger.refundWebhook(refundId)) };
    });
  }

  @Post('renew/:subscriptionId') @Public() @HttpCode(200)
  renew(@Param('subscriptionId') subscriptionId: string) {
    if (!isFakeSubscriptionId(subscriptionId)) throw new NotFoundException();
    return this.run(async ledger => {
      const period = ledger.renew(subscriptionId);
      return { period, webhook: await this.deliver(ledger.subscriptionWebhook(subscriptionId)) };
    });
  }

  @Get(':checkoutId') @Public()
  async page(@Param('checkoutId') value: string, @Res() res: PageResponse) {
    const checkoutId = this.checkoutId(value);
    const { summary, origins } = await this.run(ledger => ({ summary: ledger.summary(checkoutId),
      origins: [...new Set(['success', 'cancel'].map(outcome => new URL(ledger.returnUrl(checkoutId, outcome as 'success' | 'cancel')).origin))] }));
    this.noStore(res);
    // Form posts redirect to the stored return URLs, so those origins are allowed as form targets.
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src ${STYLE_HASH}; form-action 'self' ${origins.join(' ')}; frame-ancestors 'none'; base-uri 'none'`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const action = encodeURIComponent(checkoutId);
    const discount = summary.discount ? `<p>List price ${show(summary.money)}, discount ${show(summary.discount)}</p>` : '';
    const body = summary.state === 'paid' ? '<p>This checkout is already paid.</p>'
      : `<form method="post" action="${action}/pay"><button type="submit">Pay ${show(summary.amountDue)}</button></form>`
        + `<form method="post" action="${action}/cancel"><button type="submit">Cancel</button></form>`;
    res.status(200).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<meta name="robots" content="noindex"><title>Test checkout</title><style>${PAGE_STYLE}</style></head><body>`
      + `<p class="note">Test payment provider: no money moves.</p><h1>${escape(summary.description)}</h1>`
      + `<p>Amount due: <strong>${show(summary.amountDue)}</strong>${summary.mode === 'subscription' ? ' (first period)' : ''}</p>${discount}${body}</body></html>`);
  }

  @Post(':checkoutId/pay') @Public()
  async pay(@Param('checkoutId') value: string, @Query('webhook') webhook: string | undefined, @Res() res: PageResponse) {
    const checkoutId = this.checkoutId(value);
    if (webhook !== undefined && webhook !== 'skip') throw new BadRequestException('webhook may only be skip');
    const target = await this.run(async ledger => {
      ledger.pay(checkoutId);
      if (webhook !== 'skip') await this.deliver(ledger.checkoutWebhook(checkoutId));
      return ledger.returnUrl(checkoutId, 'success');
    });
    this.noStore(res);
    res.redirect(303, target);
  }

  @Post(':checkoutId/cancel') @Public()
  async cancel(@Param('checkoutId') value: string, @Res() res: PageResponse) {
    const checkoutId = this.checkoutId(value);
    const target = await this.run(ledger => ledger.returnUrl(checkoutId, 'cancel'));
    this.noStore(res);
    res.redirect(303, target);
  }

  @Post(':checkoutId/webhook') @Public() @HttpCode(200)
  webhook(@Param('checkoutId') value: string) {
    const checkoutId = this.checkoutId(value);
    return this.run(ledger => this.deliver(ledger.checkoutWebhook(checkoutId)));
  }

  @Post(':checkoutId/promo') @Public() @HttpCode(200)
  promo(@Param('checkoutId') value: string, @Body() body: unknown) {
    const checkoutId = this.checkoutId(value);
    const input = record(body, ['paidMoney', 'subtotalMoney', 'discountMoney', 'discountReferences']);
    const evidence: FakeCheckoutEvidence = {};
    for (const key of ['paidMoney', 'subtotalMoney', 'discountMoney'] as const) if (input[key] !== undefined) evidence[key] = money(input[key], key);
    if (input.discountReferences !== undefined) {
      const references = input.discountReferences;
      if (!Array.isArray(references) || references.length > 5 || references.some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(item)))
        throw new BadRequestException('discountReferences must be up to 5 provider codes');
      evidence.discountReferences = references as string[];
    }
    return this.run(ledger => ({ evidence: ledger.declareEvidence(checkoutId, evidence) }));
  }
}
