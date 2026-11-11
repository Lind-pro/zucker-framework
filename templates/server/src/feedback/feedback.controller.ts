import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import type { RateLimiterFragment } from '../rate-limits';
import { assertTrustedOrigin, trustedOrigins } from '../ai-tasks/ai-tasks.controller';
import { FeedbackService } from './feedback.service';

/** Per-user feedback submissions: 5 per hour (replays of the same Idempotency-Key count too). */
export const FEEDBACK_SUBMIT_LIMITER = 'feedback-submit';
export const FEEDBACK_RATE_LIMITERS: RateLimiterFragment = Object.freeze({ [FEEDBACK_SUBMIT_LIMITER]: { points: 5, duration: 3600 } });

interface FeedbackRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }
const header = (req: FeedbackRequest, name: string) => { const value = req.headers[name]; return typeof value === 'string' ? value : undefined; };

/** Signed-in users: submit feedback and read their own items with the staff reply. No edit or delete. */
@Controller('feedback')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class FeedbackController {
  private readonly origins = trustedOrigins();
  constructor(private readonly feedback: FeedbackService) {}

  @Post() @HttpCode(201) @Header('Cache-Control', 'private, no-store')
  @RateLimit({ limiter: FEEDBACK_SUBMIT_LIMITER, keyExtractor: '#userId' })
  submit(@Req() req: FeedbackRequest, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.feedback.submit(req.user.id, header(req, 'idempotency-key'), body,
      { userAgent: header(req, 'user-agent'), acceptLanguage: header(req, 'accept-language') });
  }

  @Get('mine') @Header('Cache-Control', 'private, no-store')
  mine(@Req() req: FeedbackRequest, @Query() query: Record<string, unknown>) { return this.feedback.mine(req.user.id, query); }
}

/** Back office: list/read under `feedback:query`, reply and status changes under `feedback:update`. */
@Controller('management/feedback')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class FeedbackManagementController {
  private readonly origins = trustedOrigins();
  constructor(private readonly feedback: FeedbackService) {}

  @Get() @Permissions('feedback:query') @Header('Cache-Control', 'private, no-store')
  list(@Query() query: Record<string, unknown>) { return this.feedback.list(query); }

  @Get(':id') @Permissions('feedback:query') @Header('Cache-Control', 'private, no-store')
  get(@Param('id') id: string) { return this.feedback.get(id); }

  @Patch(':id') @Permissions('feedback:update') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  update(@Req() req: FeedbackRequest, @Param('id') id: string, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.feedback.update(req.user.id, id, body);
  }
}
