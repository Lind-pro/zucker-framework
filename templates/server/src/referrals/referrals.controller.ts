import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import type { RateLimiterFragment } from '../rate-limits';
import { assertTrustedOrigin, trustedOrigins } from '../ai-tasks/ai-tasks.controller';
import { ReferralsService } from './referrals.service';

/** Claims per signed-in user: a browser claims once; the budget only bounds code guessing. */
export const REFERRAL_CLAIM_LIMITER = 'referral-claim';
export const REFERRAL_RATE_LIMITERS: RateLimiterFragment = Object.freeze({ [REFERRAL_CLAIM_LIMITER]: { points: 5, duration: 3600 } });

interface ReferralRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }

/** The signed-in user's own referral view and claim. Identity always comes from the session. */
@Controller('referrals')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class ReferralsController {
  private readonly origins = trustedOrigins();
  constructor(private readonly referrals: ReferralsService) {}

  /** `{ enabled: false, reason }` or `{ enabled: true, code, codeActive, link, stats, recent }`; the code is created on first read. */
  @Get('me') @Header('Cache-Control', 'private, no-store')
  me(@Req() req: ReferralRequest) { return this.referrals.me(req.user.id); }

  /** `{ code }` → `{ bound: true }`; any refusal is 400 `REFERRAL_NOT_APPLICABLE`. */
  @Post('claim') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  @RateLimit({ limiter: REFERRAL_CLAIM_LIMITER, keyExtractor: '#userId' })
  claim(@Req() req: ReferralRequest, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.referrals.claim(req.user.id, body);
  }
}

/** Back office: bindings with their reward decision, and per-user code disabling (audited). */
@Controller('management/referrals')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class ReferralsManagementController {
  private readonly origins = trustedOrigins();
  constructor(private readonly referrals: ReferralsService) {}

  @Get() @Permissions('referrals:query') @Header('Cache-Control', 'private, no-store')
  list(@Query() query: Record<string, unknown>) { return this.referrals.list(query); }

  @Patch('codes/:userId') @Permissions('referrals:update') @Header('Cache-Control', 'private, no-store')
  setCode(@Req() req: ReferralRequest, @Param('userId') userId: string, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.referrals.setCodeDisabled(req.user.id, userId, body);
  }
}
