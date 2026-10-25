import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, HttpException, Param, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { BatchCreditInsufficientError, CreditHoldMigrationRequiredError, CreditLotHeldError, CreditLotHoldError } from '@zucker-framework/credit';
import { HostedCheckoutError, RefundProtocolError } from '@zucker-framework/payment';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { BillingService } from '../billing.service';
import type { RefundTargetType } from './refunds.types';
interface RefundRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }

@Controller('billing/refunds')
@Permissions('billing:refund')
@UseGuards(RateLimitGuard)
@RateLimit('billing')
export class BillingRefundsController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly billing: BillingService) {}
  private origin(req: RefundRequest) { if (typeof req.headers.origin !== 'string' || !this.origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Untrusted refund request origin'); }
  private type(value: string): RefundTargetType { if (value !== 'order' && value !== 'cycle') throw new BadRequestException('Invalid refund target'); return value; }
  private empty(body: unknown) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException('Refund verification does not accept parameters'); }
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof HostedCheckoutError) throw new HttpException({ code: error.code, message: error.message },
        { invalid_input: 400, not_found: 404, forbidden: 403, conflict: 409, verification_failed: 409, unsupported: 400 }[error.code]);
      if (error instanceof BatchCreditInsufficientError || error instanceof CreditLotHoldError || error instanceof CreditLotHeldError || error instanceof CreditHoldMigrationRequiredError)
        throw new HttpException({ code: 'credits_unavailable', message: 'The original payment credits cannot currently support this refund; review usage or existing holds' }, 409);
      if (error instanceof RefundProtocolError && error.outcome === 'rejected') throw new HttpException({ code: error.code, message: 'The refund could not be submitted with the requested amount or provider capability' }, 400);
      throw new ServiceUnavailableException('Refund verification is unavailable; keep the existing request and check its status');
    }
  }
  @Header('Cache-Control', 'private, no-store')
  @Get()
  list(@Query('page') page?: string, @Query('state') state?: string) { return this.result(() => this.billing.refunds.list(page, state)); }
  @Header('Cache-Control', 'private, no-store')
  @Get('targets/:type/:id')
  target(@Param('type') type: string, @Param('id') id: string) { return this.result(() => this.billing.refunds.getTarget(this.type(type), id)); }
  @Header('Cache-Control', 'private, no-store')
  @Post('targets/:type/:id/check') @HttpCode(200)
  checkTarget(@Req() req: RefundRequest, @Param('type') type: string, @Param('id') id: string, @Body() body: unknown) {
    this.origin(req); this.empty(body); return this.result(() => this.billing.refunds.checkTarget(this.type(type), id));
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('subscriptions/:id/cycles')
  cycles(@Param('id') id: string, @Query('page') page?: string) { return this.result(() => this.billing.refunds.cycles(id, page)); }
  @Header('Cache-Control', 'private, no-store')
  @Get('events')
  events(@Query('page') page?: string) { return this.result(() => this.billing.refunds.events(page)); }
  @Header('Cache-Control', 'private, no-store')
  @Get('requests/:clientKey')
  byClientKey(@Req() req: RefundRequest, @Param('clientKey') key: string) { return this.result(() => this.billing.refunds.getByClientKey(req.user.id, key)); }
  @Header('Cache-Control', 'private, no-store')
  @Get(':id')
  get(@Param('id') id: string) { return this.result(() => this.billing.refunds.get(id)); }
  @Header('Cache-Control', 'private, no-store')
  @Post() @HttpCode(200)
  create(@Req() req: RefundRequest, @Body() body: unknown) {
    this.origin(req); const key = req.headers['idempotency-key'];
    return this.result(() => this.billing.refunds.create(req.user.id, typeof key === 'string' ? key : undefined, body));
  }
  @Header('Cache-Control', 'private, no-store')
  @Post(':id/check') @HttpCode(200)
  check(@Req() req: RefundRequest, @Param('id') id: string, @Body() body: unknown) {
    this.origin(req); this.empty(body); return this.result(() => this.billing.refunds.reconcile(id));
  }
}
