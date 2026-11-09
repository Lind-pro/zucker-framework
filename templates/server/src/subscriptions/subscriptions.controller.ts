import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { Permissions, Public } from '@zucker-framework/auth';
import { SubscriptionsService } from './subscriptions.service';

/** RFC 8.1/8.2 public plan and entitlement reads. Management routes are registered by SubscriptionsModule. */
@Controller('billing')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}
  /** Listed plans with their prices; `?currency=USD` keeps only that currency's prices. */
  @Get('plans') @Public()
  plans(@Query('currency') currency?: string) { return this.subscriptions.publicPlans(currency); }
  @Get('entitlements/catalog') @Public()
  catalog() { return this.subscriptions.catalog(); }
  @Get('entitlements/me') @Permissions() @Header('Cache-Control', 'private, no-store')
  me(@Req() request: { user: { id: string } }) { return this.subscriptions.me(request.user.id); }
}
