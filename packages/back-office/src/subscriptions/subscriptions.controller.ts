import {
  Controller, Get, Header, Inject, Optional, Query, Req, Res, UnauthorizedException, UseGuards, type CanActivate, type Type,
} from '@nestjs/common';
import { JwtAuthGuard, Permissions, PermissionsGuard, Public } from '@zucker-framework/auth';
import { SubscriptionsService } from './subscriptions.service';
import type { SubscriptionsViewer } from './subscriptions.ports';
import { SUBSCRIPTIONS_VIEWER } from './subscriptions.tokens';

interface PricingRequest { headers: Record<string, string | string[] | undefined> }
interface PricingResponse { setHeader(name: string, value: string): void }

export interface SubscriptionsPublicController {
  plans(request: PricingRequest, response: PricingResponse, currency?: string, locale?: string): Promise<unknown>;
  currencies(): Promise<unknown>;
  catalog(): unknown;
  me(request: { user?: { id?: string } }): Promise<unknown>;
}

/**
 * Public plan and entitlement reads: `GET <path>/plans|currencies|entitlements/catalog` (anonymous)
 * and `GET <path>/entitlements/me` (any signed-in user). `guards` protect only `me`.
 */
export function createSubscriptionsController(options: { path: string; guards?: Type<CanActivate>[] }): Type<SubscriptionsPublicController> {
  const guards = options.guards ?? [JwtAuthGuard, PermissionsGuard];

  @Controller(options.path)
  class SubscriptionsController implements SubscriptionsPublicController {
    constructor(
      @Inject(SubscriptionsService) readonly subscriptions: SubscriptionsService,
      @Optional() @Inject(SUBSCRIPTIONS_VIEWER) readonly viewer?: SubscriptionsViewer,
    ) {}
    /**
     * Listed plans and credit packs with their prices, plus the checkout provider policy.
     * `?currency=USD` keeps only that currency's prices; `?locale=en` localizes plan/pack text.
     * A valid bearer additionally marks the caller's `current` plan, and that personalized answer is
     * never cached by shared caches.
     */
    @Get('plans') @Public()
    async plans(@Req() request: PricingRequest, @Res({ passthrough: true }) response: PricingResponse,
      @Query('currency') currency?: string, @Query('locale') locale?: string) {
      const viewerId = this.viewer ? await this.viewer.userId(request.headers.authorization) : null;
      response.setHeader('Vary', 'Authorization');
      if (request.headers.authorization !== undefined) response.setHeader('Cache-Control', 'private, no-store');
      return this.subscriptions.pricing(currency, locale, viewerId);
    }
    @Get('currencies') @Public()
    currencies() { return this.subscriptions.currencies(); }
    @Get('entitlements/catalog') @Public()
    catalog() { return this.subscriptions.catalog(); }
    @Get('entitlements/me') @UseGuards(...guards) @Permissions() @Header('Cache-Control', 'private, no-store')
    me(@Req() request: { user?: { id?: string } }) {
      const userId = request.user?.id;
      if (typeof userId !== 'string' || !userId) throw new UnauthorizedException();
      return this.subscriptions.me(userId);
    }
  }
  return SubscriptionsController;
}
