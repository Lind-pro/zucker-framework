import { Controller, Get, Header, Query, Req, Res } from '@nestjs/common';
import { Permissions, Public } from '@zucker-framework/auth';
import { SubscriptionsService } from './subscriptions.service';
import { OptionalViewer } from './optional-viewer';

interface PricingRequest { headers: Record<string, string | string[] | undefined> }
interface PricingResponse { setHeader(name: string, value: string): void }

/** RFC 8.1/8.2 public plan and entitlement reads. Management routes are registered by SubscriptionsModule. */
@Controller('billing')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService, private readonly viewer: OptionalViewer) {}
  /**
   * Listed plans and credit packs with their prices, plus the checkout provider policy.
   * `?currency=USD` keeps only that currency's prices; `?locale=en` localizes plan/pack text.
   * Anonymous callers are welcome; a valid bearer additionally marks the caller's `current` plan, and
   * that personalized answer is never cached by shared caches.
   */
  @Get('plans') @Public()
  async plans(@Req() request: PricingRequest, @Res({ passthrough: true }) response: PricingResponse,
    @Query('currency') currency?: string, @Query('locale') locale?: string) {
    const viewerId = await this.viewer.userId(request.headers.authorization);
    response.setHeader('Vary', 'Authorization');
    if (request.headers.authorization !== undefined) response.setHeader('Cache-Control', 'private, no-store');
    return this.subscriptions.pricing(currency, locale, viewerId);
  }
  @Get('currencies') @Public()
  currencies() { return this.subscriptions.currencies(); }
  @Get('entitlements/catalog') @Public()
  catalog() { return this.subscriptions.catalog(); }
  @Get('entitlements/me') @Permissions() @Header('Cache-Control', 'private, no-store')
  me(@Req() request: { user: { id: string } }) { return this.subscriptions.me(request.user.id); }
}
