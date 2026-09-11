import type { Type, CanActivate } from '@nestjs/common';
import { ExecutionContext, Injectable, Inject } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OAuthStateService } from '../oauth-state';
import type { RefreshCookieResponse } from '../session/refresh-token-cookie';

interface OAuthRequest {
  headers: { cookie?: string };
  query: { state?: unknown; code?: unknown };
  oauthState?: string;
}

/** Passport transport for signed browser-bound OAuth state; strategy selection remains configuration. */
export function createOAuthStateGuard(strategy: string): Type<CanActivate> {
  @Injectable()
  class OAuthStateGuard extends AuthGuard(strategy) {
    constructor(@Inject(OAuthStateService) private readonly stateService: OAuthStateService) {
      super();
    }
    override canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest<OAuthRequest>();
      const response = context.switchToHttp().getResponse<RefreshCookieResponse>();
      const state = typeof request.query.state === 'string' ? request.query.state : undefined;
      if (state || request.query.code) this.stateService.verify(request, response, strategy, state);
      else request.oauthState = this.stateService.issue(response, strategy);
      return super.canActivate(context);
    }
    override getAuthenticateOptions(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest<OAuthRequest>();
      return request.oauthState ? { state: request.oauthState } : undefined;
    }
  }
  return OAuthStateGuard;
}
