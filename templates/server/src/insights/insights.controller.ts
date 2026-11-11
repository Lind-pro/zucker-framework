import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { InsightsService } from './insights.service';

/** Permission of the insights endpoints; separate from `dashboard:query` because it exposes revenue. */
export const INSIGHTS_PERMISSION = 'insights:query';

/**
 * Back-office aggregates: `GET /management/insights/summary?days&tz` and
 * `GET /management/insights/series?metric&days&tz`. Read-only, so no Origin check; responses are
 * private and never cached by intermediaries.
 */
@Controller('management/insights')
@Permissions(INSIGHTS_PERMISSION)
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('summary') @Header('Cache-Control', 'private, no-store')
  summary(@Query() query: Record<string, unknown>) { return this.insights.summary(query); }

  @Get('series') @Header('Cache-Control', 'private, no-store')
  series(@Query() query: Record<string, unknown>) { return this.insights.series(query); }
}
