import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { creditPageOptions } from './credits.service';
import { QuotaService } from './quota.service';

@Controller('quota')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}
  @Get('record')
  record(@Req() request: { user: { id: string } }) { return this.quota.recordSnapshot(request.user.id); }
  @Get('reservations')
  list(@Req() request: { user: { id: string } }, @Query() query: Record<string, unknown>) { return this.quota.list(request.user.id, creditPageOptions(query, false)); }
  @Get('reservations/:id')
  get(@Req() request: { user: { id: string } }, @Param('id') id: string) { return this.quota.get(request.user.id, id); }
}
