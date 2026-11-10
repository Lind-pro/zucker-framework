import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, Param, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Permissions, Public } from '@zucker-framework/auth';
import { HostedCheckoutError } from '@zucker-framework/payment';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { BillingService } from './billing.service';
import { BILLING_WEBHOOK_LIMITER } from '../rate-limits';

interface BillingRequest {
  user: { id: string };
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('billing')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit('billing')
export class BillingController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly billing: BillingService) {}
  private origin(req: BillingRequest): void {
    if (typeof req.headers.origin !== 'string' || !this.origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ForbiddenException('Untrusted billing request origin');
    }
  }
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof HostedCheckoutError) {
        const status = { invalid_input: 400, not_found: 404, forbidden: 403, conflict: 409, verification_failed: 409, unsupported: 400 }[error.code];
        throw new HttpException({ code: error.code, message: error.message }, status);
      }
      // Gateway errors can contain provider bodies. A claimed dispatch is retained for reconciliation.
      throw new ServiceUnavailableException('Payment verification is unavailable; keep the order for reconciliation');
    }
  }
  @Get('catalog') @Public()
  catalog() { return this.billing.catalog.list(); }
  @Get('orders')
  list(@Req() req: BillingRequest, @Query('page') page?: string) { return this.result(() => this.billing.list(req.user.id, page)); }
  @Post('orders') @HttpCode(200)
  create(@Req() req: BillingRequest, @Body() body: unknown) {
    this.origin(req);
    const key = req.headers['idempotency-key'];
    return this.result(async () => this.billing.present(await this.billing.create(req.user.id, typeof key === 'string' ? key : undefined, body)));
  }
  @Get('orders/:id')
  get(@Req() req: BillingRequest, @Param('id') id: string) {
    return this.result(async () => this.billing.present(await this.billing.checkout.get(id, req.user.id)));
  }
  @Post('orders/:id/confirm') @HttpCode(200)
  confirm(@Req() req: BillingRequest, @Param('id') id: string, @Body() body: unknown) {
    this.origin(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'checkoutId')) throw new BadRequestException('Invalid checkout confirmation');
    const hint = (body as { checkoutId?: unknown }).checkoutId;
    if (hint !== undefined && (typeof hint !== 'string' || !hint.trim() || hint.length > 255 || /[\s\x00-\x1f\x7f]/.test(hint))) {
      throw new BadRequestException('Invalid checkout identity');
    }
    return this.result(() => this.billing.confirm(id, req.user.id, typeof hint === 'string' ? hint : undefined));
  }
  @Post('orders/:id/capture') @HttpCode(200)
  capture(@Req() req: BillingRequest, @Param('id') id: string, @Body() body: unknown) {
    this.origin(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || (body as { approved?: unknown }).approved !== true) throw new BadRequestException('Explicit payment approval is required');
    return this.result(async () => this.billing.present(await this.billing.checkout.capture({ orderId: id, ownerId: req.user.id })));
  }
  @Get('balance')
  balance(@Req() req: BillingRequest) { return this.result(() => this.billing.balance(req.user.id)); }
  /** Provider callbacks get their own generous per-source budget: a sale spike must not 429 behind the user budget. */
  @Post('webhooks/:provider') @Public() @HttpCode(200) @RateLimit(BILLING_WEBHOOK_LIMITER)
  webhook(@Req() req: BillingRequest, @Param('provider') provider: string) {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException('Raw webhook bytes are required');
    const headers = Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    return this.result(async () => {
      await this.billing.webhook(provider, { rawBody, headers });
      return { received: true };
    });
  }
}
