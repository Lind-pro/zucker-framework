import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { assertTrustedOrigin, trustedOrigins } from '../ai-tasks/ai-tasks.controller';
import { PromotionsService } from './promotions.service';

interface PromotionsRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }

/**
 * `/management/promotions`: promo code administration. Writes are compare-and-swap on `revision`
 * with an `operationLogs` row in the same transaction. Checkout alias lookups go through
 * `POST /billing/orders` (the `billing` limiter), never through this controller.
 */
@Controller('management/promotions')
@Permissions('promotions:query')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class PromotionsController {
  private readonly origins = trustedOrigins();
  constructor(private readonly promotions: PromotionsService) {}

  @Get() @Header('Cache-Control', 'private, no-store')
  list(@Query() query: Record<string, unknown>) { return this.promotions.list(query); }

  @Get(':id') @Header('Cache-Control', 'private, no-store')
  get(@Param('id') id: string) { return this.promotions.get(id); }

  @Get(':id/redemptions') @Header('Cache-Control', 'private, no-store')
  redemptions(@Param('id') id: string, @Query() query: Record<string, unknown>) { return this.promotions.redemptions(id, query); }

  @Post() @HttpCode(201) @Permissions('promotions:create') @Header('Cache-Control', 'private, no-store')
  create(@Req() req: PromotionsRequest, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.promotions.create(req.user.id, body);
  }

  @Put(':id') @Permissions('promotions:update') @Header('Cache-Control', 'private, no-store')
  update(@Req() req: PromotionsRequest, @Param('id') id: string, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.promotions.update(req.user.id, id, body);
  }

  @Post(':id/status') @HttpCode(200) @Permissions('promotions:update') @Header('Cache-Control', 'private, no-store')
  status(@Req() req: PromotionsRequest, @Param('id') id: string, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.promotions.status(req.user.id, id, body);
  }

  /** `?expectedRevision=<n>`; refused (409) once the promotion has been reserved or redeemed. */
  @Delete(':id') @HttpCode(200) @Permissions('promotions:delete') @Header('Cache-Control', 'private, no-store')
  remove(@Req() req: PromotionsRequest, @Param('id') id: string, @Query('expectedRevision') expectedRevision?: string) {
    assertTrustedOrigin(this.origins, req);
    return this.promotions.remove(req.user.id, id, expectedRevision);
  }
}
