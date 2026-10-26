import { CanActivate, ExecutionContext, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthenticationHolder, fromJwtUser, IS_PUBLIC_KEY } from '@zucker-framework/auth';
import { AccountService } from './account.service';
import { ACCOUNT_API_KEY_AUTHENTICATOR, ACCOUNT_API_KEY_SCOPES } from './api-key-authentication';

@Injectable()
export class AccountGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService,
    private readonly accounts: AccountService, private readonly holder: AuthenticationHolder,
    @Optional() @Inject(ACCOUNT_API_KEY_AUTHENTICATOR) private readonly apiKeys?: CanActivate) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const keyScopes = this.reflector.getAllAndOverride<string[]>(ACCOUNT_API_KEY_SCOPES, [context.getHandler(), context.getClass()]);
    if (keyScopes !== undefined) {
      if (!this.apiKeys) throw new UnauthorizedException('API key authentication is unavailable');
      const allowed = this.apiKeys.canActivate(context);
      if (typeof allowed === 'boolean') return allowed;
      if (allowed instanceof Promise) return allowed;
      throw new UnauthorizedException('Unsupported API key authenticator');
    }
    if (this.reflector.getAllAndOverride(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest();
    const header: unknown = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer \S+$/i.test(header)) throw new UnauthorizedException();
    let payload: { sub: string; sid: string; tokenUse: string };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7), { algorithms: ['HS256'], audience: 'zucker:access' });
      if (payload.tokenUse !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error();
    } catch { throw new UnauthorizedException(); }
    const user = await this.accounts.currentUser(payload.sub, payload.sid);
    req.user = { id: user.id, username: user.username, sid: payload.sid };
    req.auth = await this.holder.resolve({ request: req }) ?? fromJwtUser(req.user);
    return true;
  }
}
