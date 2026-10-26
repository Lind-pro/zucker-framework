import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, Param, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { HostedCheckoutError, SubscriptionProtocolError } from '@zucker-framework/payment';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { BillingService } from './billing.service';

interface SubscriptionRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }
@Controller('billing/subscriptions')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit('billing')
export class BillingSubscriptionsController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly billing: BillingService) {}
  private origin(request: SubscriptionRequest): void {
    if (typeof request.headers.origin !== 'string' || !this.origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Untrusted subscription request origin');
  }
  private empty(body: unknown): void {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException('Subscription action does not accept parameters');
  }
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof HostedCheckoutError) {
        const status = { invalid_input: 400, not_found: 404, forbidden: 403, conflict: 409, verification_failed: 409, unsupported: 400 }[error.code];
        throw new HttpException({ code: error.code, message: error.message }, status);
      }
      if (error instanceof SubscriptionProtocolError) {
        const status = { invalid_input: 400, invalid_response: 409, unsupported: 400, verification_failed: 409, transport_error: 503 }[error.code];
        throw new HttpException({ code: error.code, message: 'Subscription provider evidence could not be verified' }, status);
      }
      throw new ServiceUnavailableException('Subscription verification is unavailable; keep the subscription for reconciliation');
    }
  }
  @Get()
  list(@Req() request: SubscriptionRequest, @Query('page') page?: string) { return this.result(() => this.billing.subscriptions.list(request.user.id, page)); }
  @Get(':id')
  get(@Req() request: SubscriptionRequest, @Param('id') id: string) { return this.result(() => this.billing.subscriptions.get(id, request.user.id)); }
  @Post(':id/refresh') @HttpCode(200)
  refresh(@Req() request: SubscriptionRequest, @Param('id') id: string, @Body() body: unknown) {
    this.origin(request); this.empty(body); return this.result(() => this.billing.subscriptions.refresh(id, request.user.id));
  }
  @Post(':id/cancel') @HttpCode(200)
  cancel(@Req() request: SubscriptionRequest, @Param('id') id: string, @Body() body: unknown) {
    this.origin(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('mode' in body)
      || body.mode !== 'immediate' && body.mode !== 'period_end') throw new BadRequestException('Explicit subscription cancellation mode is required');
    const mode = body.mode;
    return this.result(() => this.billing.subscriptions.cancel(id, request.user.id, mode));
  }
  @Get(':id/invoices')
  invoices(@Req() request: SubscriptionRequest, @Param('id') id: string, @Query('page') page?: string) { return this.result(() => this.billing.subscriptions.invoices(id, request.user.id, page)); }
  @Post(':id/portal') @HttpCode(200)
  portal(@Req() request: SubscriptionRequest, @Param('id') id: string, @Body() body: unknown) {
    this.origin(request); this.empty(body); return this.result(() => this.billing.subscriptions.portal(id, request.user.id));
  }
}
