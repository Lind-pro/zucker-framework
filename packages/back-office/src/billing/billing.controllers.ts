import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, HttpException, Inject, Logger, NotFoundException,
  Optional, Param, Post, Query, Req, Res, ServiceUnavailableException, UseGuards, type CanActivate, type InjectionToken, type Type,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { JwtAuthGuard, Permissions, PermissionsGuard, Public } from '@zucker-framework/auth';
import { BatchCreditInsufficientError, CreditHoldMigrationRequiredError, CreditLotHeldError, CreditLotHoldError } from '@zucker-framework/credit';
import { HostedCheckoutError, RefundProtocolError, SubscriptionProtocolError, type HostedCheckoutPromotionQuote, type Money } from '@zucker-framework/payment';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import type { BillingService } from './billing.service';
import { BILLING_FAKE_LEDGER_SOURCE } from './billing.tokens';
import type { PaymentCredentialRetention } from './payment-credential-retention';
import { parsePaymentPurgeRequest } from './payment-credential-retention';
import type { RefundTargetType } from './refunds/refunds.types';
import {
  FAKE_PAYMENT_PROVIDER_ID, isFakeCheckoutId, isFakeRefundId, isFakeSubscriptionId, parseFakeMoney,
  type FakeCheckoutEvidence, type FakePaymentLedger, type FakeSignedWebhook,
} from './test-fakes/fake-payment-provider';

type RateLimitSetting = Parameters<typeof RateLimit>[0];
/** Shared controller composition: guards, browser origin check and rate limits. */
export interface BillingControllerSettings {
  /** Injection token (or class) of the {@link BillingService} instance. */
  service: InjectionToken;
  /** Exact browser origins allowed to change state; read once per controller instance. */
  trustedOrigins: () => readonly string[];
  /** Default `[JwtAuthGuard, PermissionsGuard]`; `[]` when the consumer applies global guards. */
  guards?: Type<CanActivate>[];
  /** Per-user limiter for billing routes (`false`: none). Default `'billing'`. */
  rateLimit?: RateLimitSetting | false;
  /** Limiter for provider callbacks and the test checkout (`false`: none). Default `'billing-webhook'`. */
  webhookRateLimit?: RateLimitSetting | false;
}
interface BrowserRequest {
  user: { id: string };
  ip?: string;
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

const CHECKOUT_STATUS = { invalid_input: 400, not_found: 404, forbidden: 403, conflict: 409, verification_failed: 409, unsupported: 400 } as const;
function trusted(settings: BillingControllerSettings): (request: BrowserRequest, label: string) => void {
  const origins = new Set(settings.trustedOrigins().map(value => value.trim()).filter(Boolean));
  return (request, label) => {
    if (typeof request.headers.origin !== 'string' || !origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException(`Untrusted ${label} request origin`);
  };
}
function guards(settings: BillingControllerSettings, limited: boolean): Type<CanActivate>[] {
  return [...(settings.guards ?? [JwtAuthGuard, PermissionsGuard]), ...(limited ? [RateLimitGuard] : [])];
}
function limit(setting: RateLimitSetting | false | undefined, fallback: RateLimitSetting): RateLimitSetting | null {
  return setting === false ? null : setting ?? fallback;
}
const noop: ClassDecorator & MethodDecorator = () => undefined;
function limited(setting: RateLimitSetting | null): ClassDecorator & MethodDecorator { return setting ? RateLimit(setting) : noop; }
function emptyBody(body: unknown, message: string): void {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException(message);
}

async function checkoutResult<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HttpException) throw error;
    if (error instanceof HostedCheckoutError) throw new HttpException({ code: error.code, message: error.message }, CHECKOUT_STATUS[error.code]);
    // A callback whose signature/headers do not verify (refund and subscription adapters) is the
    // caller's fault: fail closed with a 4xx, never a retryable 5xx. Nothing was recorded.
    if ((error instanceof RefundProtocolError || error instanceof SubscriptionProtocolError)
      && (error.code === 'verification_failed' || error.code === 'invalid_input')) {
      throw new BadRequestException({ code: error.code, message: 'Provider request could not be verified' });
    }
    // Gateway errors can contain provider bodies. A claimed dispatch is retained for reconciliation.
    throw new ServiceUnavailableException('Payment verification is unavailable; keep the order for reconciliation');
  }
}

/**
 * `/billing`: catalog (public), the buyer's orders, confirmation, explicit capture, balance (credit
 * ledger only) and `POST /billing/webhooks/:provider` (public, raw body required).
 */
export function createBillingController(settings: BillingControllerSettings & { path?: string; balance?: boolean }): Type<unknown> {
  const user = limit(settings.rateLimit, 'billing'), webhook = limit(settings.webhookRateLimit, 'billing-webhook');
  @Controller(settings.path ?? 'billing')
  @Permissions()
  @UseGuards(...guards(settings, !!(user || webhook)))
  @limited(user)
  class BillingController {
    readonly origin = trusted(settings);
    constructor(@Inject(settings.service) readonly billing: BillingService) {}
    @Get('catalog') @Public()
    catalog() { return this.billing.catalog.list(); }
    @Get('orders')
    list(@Req() req: BrowserRequest, @Query('page') page?: string) { return checkoutResult(() => this.billing.list(req.user.id, page)); }
    @Post('orders') @HttpCode(200)
    create(@Req() req: BrowserRequest, @Body() body: unknown) {
      this.origin(req, 'billing');
      const key = req.headers['idempotency-key'];
      return checkoutResult(async () => this.billing.present(await this.billing.create(req.user.id, typeof key === 'string' ? key : undefined, body)));
    }
    @Get('orders/:id')
    get(@Req() req: BrowserRequest, @Param('id') id: string) {
      return checkoutResult(async () => this.billing.present(await this.billing.checkout.get(id, req.user.id)));
    }
    @Post('orders/:id/confirm') @HttpCode(200)
    confirm(@Req() req: BrowserRequest, @Param('id') id: string, @Body() body: unknown) {
      this.origin(req, 'billing');
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => key !== 'checkoutId')) throw new BadRequestException('Invalid checkout confirmation');
      const hint = (body as { checkoutId?: unknown }).checkoutId;
      if (hint !== undefined && (typeof hint !== 'string' || !hint.trim() || hint.length > 255 || /[\s\x00-\x1f\x7f]/.test(hint))) {
        throw new BadRequestException('Invalid checkout identity');
      }
      return checkoutResult(() => this.billing.confirm(id, req.user.id, typeof hint === 'string' ? hint : undefined));
    }
    @Post('orders/:id/capture') @HttpCode(200)
    capture(@Req() req: BrowserRequest, @Param('id') id: string, @Body() body: unknown) {
      this.origin(req, 'billing');
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
        || (body as { approved?: unknown }).approved !== true) throw new BadRequestException('Explicit payment approval is required');
      return checkoutResult(async () => this.billing.present(await this.billing.checkout.capture({ orderId: id, ownerId: req.user.id })));
    }
    @Get('balance')
    balance(@Req() req: BrowserRequest) {
      if (settings.balance === false) throw new NotFoundException();
      return checkoutResult(() => this.billing.balance(req.user.id));
    }
    /** Provider callbacks get their own generous per-source budget: a sale spike must not 429 behind the user budget. */
    @Post('webhooks/:provider') @Public() @HttpCode(200) @limited(webhook)
    webhook(@Req() req: BrowserRequest, @Param('provider') provider: string) {
      const rawBody = req.rawBody;
      if (!rawBody) throw new BadRequestException('Raw webhook bytes are required');
      const headers = Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      return checkoutResult(async () => {
        await this.billing.webhook(provider, { rawBody, headers });
        return { received: true };
      });
    }
  }
  return BillingController;
}

/** `/billing/subscriptions`: the buyer's provider subscriptions (list, refresh, cancel, invoices, portal). */
export function createBillingSubscriptionsController(settings: BillingControllerSettings & { path?: string }): Type<unknown> {
  const user = limit(settings.rateLimit, 'billing');
  async function result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof HostedCheckoutError) throw new HttpException({ code: error.code, message: error.message }, CHECKOUT_STATUS[error.code]);
      if (error instanceof SubscriptionProtocolError) {
        const status = { invalid_input: 400, invalid_response: 409, unsupported: 400, verification_failed: 409, transport_error: 503 }[error.code];
        throw new HttpException({ code: error.code, message: 'Subscription provider evidence could not be verified' }, status);
      }
      throw new ServiceUnavailableException('Subscription verification is unavailable; keep the subscription for reconciliation');
    }
  }
  @Controller(settings.path ?? 'billing/subscriptions')
  @Permissions()
  @UseGuards(...guards(settings, !!user))
  @limited(user)
  class BillingSubscriptionsController {
    readonly origin = trusted(settings);
    constructor(@Inject(settings.service) readonly billing: BillingService) {}
    @Get()
    list(@Req() request: BrowserRequest, @Query('page') page?: string) { return result(() => this.billing.subscriptions.list(request.user.id, page)); }
    @Get(':id')
    get(@Req() request: BrowserRequest, @Param('id') id: string) { return result(() => this.billing.subscriptions.get(id, request.user.id)); }
    @Post(':id/refresh') @HttpCode(200)
    refresh(@Req() request: BrowserRequest, @Param('id') id: string, @Body() body: unknown) {
      this.origin(request, 'subscription'); emptyBody(body, 'Subscription action does not accept parameters');
      return result(() => this.billing.subscriptions.refresh(id, request.user.id));
    }
    @Post(':id/cancel') @HttpCode(200)
    cancel(@Req() request: BrowserRequest, @Param('id') id: string, @Body() body: unknown) {
      this.origin(request, 'subscription');
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('mode' in body)
        || body.mode !== 'immediate' && body.mode !== 'period_end') throw new BadRequestException('Explicit subscription cancellation mode is required');
      const mode = body.mode;
      return result(() => this.billing.subscriptions.cancel(id, request.user.id, mode));
    }
    @Get(':id/invoices')
    invoices(@Req() request: BrowserRequest, @Param('id') id: string, @Query('page') page?: string) { return result(() => this.billing.subscriptions.invoices(id, request.user.id, page)); }
    @Post(':id/portal') @HttpCode(200)
    portal(@Req() request: BrowserRequest, @Param('id') id: string, @Body() body: unknown) {
      this.origin(request, 'subscription'); emptyBody(body, 'Subscription action does not accept parameters');
      return result(() => this.billing.subscriptions.portal(id, request.user.id));
    }
  }
  return BillingSubscriptionsController;
}

async function refundResult<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HttpException) throw error;
    if (error instanceof HostedCheckoutError) throw new HttpException({ code: error.code, message: error.message }, CHECKOUT_STATUS[error.code]);
    if (error instanceof BatchCreditInsufficientError || error instanceof CreditLotHoldError || error instanceof CreditLotHeldError || error instanceof CreditHoldMigrationRequiredError)
      throw new HttpException({ code: 'credits_unavailable', message: 'The original payment credits cannot currently support this refund; review usage or existing holds' }, 409);
    if (error instanceof RefundProtocolError && error.outcome === 'rejected') throw new HttpException({ code: error.code, message: 'The refund could not be submitted with the requested amount or provider capability' }, 400);
    throw new ServiceUnavailableException('Refund verification is unavailable; keep the existing request and check its status');
  }
}

/**
 * `/billing/refunds` (administrators, `billing:refund`): refund targets, requests with idempotent
 * creation, read-only checks and unmatched provider events. A request is dispatched at most once; a
 * lost provider response is resolved by checks, never by a second dispatch.
 */
export function createBillingRefundsController(settings: BillingControllerSettings & { path?: string; permission?: string }): Type<unknown> {
  const user = limit(settings.rateLimit, 'billing');
  const type = (value: string): RefundTargetType => { if (value !== 'order' && value !== 'cycle') throw new BadRequestException('Invalid refund target'); return value; };
  const noParameters = (body: unknown) => emptyBody(body, 'Refund verification does not accept parameters');
  @Controller(settings.path ?? 'billing/refunds')
  @Permissions(settings.permission ?? 'billing:refund')
  @UseGuards(...guards(settings, !!user))
  @limited(user)
  class BillingRefundsController {
    readonly origin = trusted(settings);
    constructor(@Inject(settings.service) readonly billing: BillingService) {}
    @Header('Cache-Control', 'private, no-store')
    @Get()
    list(@Query('page') page?: string, @Query('state') state?: string) { return refundResult(() => this.billing.refunds.list(page, state)); }
    @Header('Cache-Control', 'private, no-store')
    @Get('targets/:type/:id')
    target(@Param('type') kind: string, @Param('id') id: string) { return refundResult(() => this.billing.refunds.getTarget(type(kind), id)); }
    @Header('Cache-Control', 'private, no-store')
    @Post('targets/:type/:id/check') @HttpCode(200)
    checkTarget(@Req() req: BrowserRequest, @Param('type') kind: string, @Param('id') id: string, @Body() body: unknown) {
      this.origin(req, 'refund'); noParameters(body); return refundResult(() => this.billing.refunds.checkTarget(type(kind), id));
    }
    @Header('Cache-Control', 'private, no-store')
    @Get('subscriptions/:id/cycles')
    cycles(@Param('id') id: string, @Query('page') page?: string) { return refundResult(() => this.billing.refunds.cycles(id, page)); }
    @Header('Cache-Control', 'private, no-store')
    @Get('events')
    events(@Query('page') page?: string) { return refundResult(() => this.billing.refunds.events(page)); }
    @Header('Cache-Control', 'private, no-store')
    @Get('requests/:clientKey')
    byClientKey(@Req() req: BrowserRequest, @Param('clientKey') key: string) { return refundResult(() => this.billing.refunds.getByClientKey(req.user.id, key)); }
    @Header('Cache-Control', 'private, no-store')
    @Get(':id')
    get(@Param('id') id: string) { return refundResult(() => this.billing.refunds.get(id)); }
    @Header('Cache-Control', 'private, no-store')
    @Post() @HttpCode(200)
    create(@Req() req: BrowserRequest, @Body() body: unknown) {
      this.origin(req, 'refund'); const key = req.headers['idempotency-key'];
      return refundResult(() => this.billing.refunds.create(req.user.id, typeof key === 'string' ? key : undefined, body));
    }
    @Header('Cache-Control', 'private, no-store')
    @Post(':id/check') @HttpCode(200)
    check(@Req() req: BrowserRequest, @Param('id') id: string, @Body() body: unknown) {
      this.origin(req, 'refund'); noParameters(body); return refundResult(() => this.billing.refunds.reconcile(id));
    }
  }
  return BillingRefundsController;
}

/**
 * `POST <path>/:id/recover` `{ checkoutId }` (administrators): recover an order whose provider
 * response was lost from a provider session id (see `BillingService.recover`). Default path
 * `management/orders`, permission `billing:refund`.
 */
export function createBillingOrderRecoveryController(settings: BillingControllerSettings & { path?: string; permission?: string }): Type<unknown> {
  const user = limit(settings.rateLimit, 'billing');
  @Controller(settings.path ?? 'management/orders')
  @UseGuards(...guards(settings, !!user))
  @limited(user)
  class BillingOrderRecoveryController {
    readonly origin = trusted(settings);
    constructor(@Inject(settings.service) readonly billing: BillingService) {}
    @Post(':id/recover') @Permissions(settings.permission ?? 'billing:refund') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
    recover(@Req() req: BrowserRequest, @Param('id') id: string, @Body() body: unknown) {
      this.origin(req, 'order recovery');
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('checkoutId' in body))
        throw new BadRequestException('Order recovery needs exactly { checkoutId }');
      return checkoutResult(() => this.billing.recover(id, (body as { checkoutId: unknown }).checkoutId));
    }
  }
  return BillingOrderRecoveryController;
}

/**
 * `/management/payment-credentials` (D13): retained payment credential revisions and the operator
 * purge. Permission (default `config:update`) at the guard plus the operator check in the service;
 * trusted Origin on the write. Responses carry revision numbers, dates, hold reasons and counts only.
 */
export function createPaymentCredentialsController(settings: Omit<BillingControllerSettings, 'service'> & {
  retention: InjectionToken; path?: string; permission?: string;
}): Type<unknown> {
  const user = limit(settings.rateLimit, { limiter: 'api-default', keyExtractor: '#userId' });
  const path = settings.path ?? 'management/payment-credentials';
  @Controller(path)
  @UseGuards(...guards({ ...settings, service: settings.retention }, !!user))
  @limited(user)
  class PaymentCredentialsController {
    readonly origin = trusted({ ...settings, service: settings.retention });
    constructor(@Inject(settings.retention) readonly retention: PaymentCredentialRetention) {}
    /** `→ { retentionDays, profiles: [{ profileId, revisions: [{ revision, createdAt, current, holds, purgeable }] }] }` */
    @Get('revisions') @Permissions(settings.permission ?? 'config:update') @Header('Cache-Control', 'private, no-store')
    revisions(@Req() request: BrowserRequest) { return this.retention.inventory(request.user.id); }
    /**
     * `{ profileId, dryRun?: boolean = true, revisions?: number[] }` → `{ profileId, dryRun, retentionDays,
     * selected, deleted, retainedRevisions }`; 409 `PAYMENT_REVISION_HELD` with `details.refused` when an
     * explicitly requested revision is held (nothing is deleted).
     */
    @Post('purge') @Permissions(settings.permission ?? 'config:update') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
    purge(@Req() request: BrowserRequest, @Body() body: unknown) {
      this.origin(request, 'payment credential purge');
      const input = parsePaymentPurgeRequest(body, this.retention.profileIds());
      return this.retention.purge(request.user.id, input, { method: 'POST', path: `/${path}/purge`, ipAddress: request.ip });
    }
  }
  return PaymentCredentialsController;
}

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
 * TEST-ONLY hosted checkout of the `fake` provider. Register it only when the fake provider is
 * configured, never in production. All routes are public, as a real provider's page is. Redirect
 * targets come from the order the fake was created with, never from the request; webhooks go
 * through the application's own verification (`BillingService.webhook`).
 *
 * - `GET  :checkoutId`            hosted page (no script, strict CSP): description and amounts, Pay / Cancel.
 * - `POST :checkoutId/pay`        pays, sends the signed `checkout.completed` webhook in process (skip with
 *                                 `?webhook=skip`) and redirects (303) to the order's success URL.
 * - `POST :checkoutId/cancel`     redirects (303) to the order's cancel URL; the checkout stays pending.
 * - `POST :checkoutId/webhook`    sends the signed webhook again; returns it for replay.
 * - `POST :checkoutId/promo`      before payment: overrides the evidence the provider will report.
 * - `POST promotions`             declares what the provider's promotion would discount.
 * - `POST renew/:subscriptionId`  next paid period at the list price, plus the signed `subscription.updated` webhook.
 * - `POST refunds/mode`           `{state: 'pending' | 'succeeded' | 'failed'}` for refunds created afterwards.
 * - `POST refunds/:refundId/settle` `{state: 'succeeded' | 'failed' | 'canceled'}` plus the signed `refund.updated` webhook.
 */
export function createFakeCheckoutController(settings: {
  service: InjectionToken;
  /** Optional provider injected next to the service and handed to `ledger` (for example the runtime options). */
  ledgerSource?: InjectionToken;
  /** The fake ledger behind the configured providers (null: every route answers 404). */
  ledger: (billing: BillingService, source: unknown) => FakePaymentLedger | null;
  path?: string;
  rateLimit?: RateLimitSetting | false;
  /** Called by the constructor (for example to refuse production). */
  assertAllowed?: () => void;
}): Type<unknown> {
  const webhook = limit(settings.rateLimit, 'billing-webhook');
  @Controller(settings.path ?? 'billing/test-checkout')
  @UseGuards(...(webhook ? [RateLimitGuard] : []))
  @limited(webhook)
  class FakeCheckoutController {
    readonly logger = new Logger('FakePaymentProvider');
    constructor(@Inject(settings.service) readonly billing: BillingService,
      @Optional() @Inject(settings.ledgerSource ?? BILLING_FAKE_LEDGER_SOURCE) readonly source?: unknown) { settings.assertAllowed?.(); }
    ledger(): FakePaymentLedger {
      const ledger = settings.ledger(this.billing, this.source);
      if (!ledger) throw new NotFoundException();
      return ledger;
    }
    async run<T>(work: (ledger: FakePaymentLedger) => T | Promise<T>): Promise<T> {
      const ledger = this.ledger();
      try { return await work(ledger); }
      catch (error) {
        if (error instanceof HttpException) throw error;
        if (error instanceof HostedCheckoutError) throw new HttpException({ code: error.code, message: error.message }, error.code === 'not_found' ? 404 : 409);
        if (error instanceof RefundProtocolError || error instanceof SubscriptionProtocolError) throw new HttpException({ code: error.code, message: error.message }, 409);
        throw error;
      }
    }
    checkoutId(value: string): string {
      if (!isFakeCheckoutId(value)) throw new NotFoundException();
      return value;
    }
    /** Delivers like a provider would: through the application's verification. A failure is reported, not thrown. */
    async deliver(webhook: FakeSignedWebhook): Promise<{ delivered: boolean; error?: string; request: { body: string; headers: Record<string, string> } }> {
      try {
        await this.billing.webhook(FAKE_PAYMENT_PROVIDER_ID, { rawBody: Buffer.from(webhook.rawBody), headers: webhook.headers });
        return { delivered: true, request: { body: webhook.rawBody, headers: webhook.headers } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Webhook delivery failed';
        this.logger.warn(`Fake webhook was not accepted: ${message}`);
        return { delivered: false, error: message, request: { body: webhook.rawBody, headers: webhook.headers } };
      }
    }
    noStore(res: PageResponse) {
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
  return FakeCheckoutController;
}
