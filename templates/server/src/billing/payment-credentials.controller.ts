import { Body, Controller, ForbiddenException, Get, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { parsePaymentPurgeRequest, PaymentCredentialRetention } from './payment-credential-retention';

interface OperatorRequest { user: { id: string }; ip?: string; headers: Record<string, string | string[] | undefined> }

/**
 * `/management/payment-credentials` (D13): retained payment credential revisions and the operator
 * purge. `config:update` at the guard plus the `superadmin` role in the service; trusted Origin on
 * the write. Responses carry revision numbers, dates, hold reasons and counts only, never values.
 */
@Controller('management/payment-credentials')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class PaymentCredentialsController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly retention: PaymentCredentialRetention) {}

  /** `→ { retentionDays, profiles: [{ profileId, revisions: [{ revision, createdAt, current, holds, purgeable }] }] }` */
  @Get('revisions') @Permissions('config:update') @Header('Cache-Control', 'private, no-store')
  revisions(@Req() request: OperatorRequest) { return this.retention.inventory(request.user.id); }

  /**
   * `{ profileId, dryRun?: boolean = true, revisions?: number[] }` → `{ profileId, dryRun, retentionDays,
   * selected, deleted, retainedRevisions }`; 409 `PAYMENT_REVISION_HELD` with `result.details.refused` (`[{ revision, holds }]`) when an explicitly
   * requested revision is held (nothing is deleted).
   */
  @Post('purge') @Permissions('config:update') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  purge(@Req() request: OperatorRequest, @Body() body: unknown) {
    if (typeof request.headers.origin !== 'string' || !this.origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException('Untrusted payment credential purge origin');
    const input = parsePaymentPurgeRequest(body);
    return this.retention.purge(request.user.id, input, { method: 'POST', path: '/management/payment-credentials/purge', ipAddress: request.ip });
  }
}
