import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { DeliveryService } from './delivery.service';

@Controller('deliveries')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}
  @Get('for-task/:id')
  forTask(@Req() request: { user: { id: string } }, @Param('id') id: string) { return this.delivery.forTask(request.user.id, id); }
  @Get(':id')
  get(@Req() request: { user: { id: string } }, @Param('id') id: string) { return this.delivery.getOwned(request.user.id, id); }
}
