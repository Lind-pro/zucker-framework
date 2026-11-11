import { Inject, Injectable, Optional, SetMetadata, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthenticationHolder, fromJwtUser, IS_PUBLIC_KEY } from '@zucker-framework/auth';
import { AccountService } from './account.service';
import type { AccountAccessIdentity, AccountAccessTokenVerifier } from './accounts.ports';
import { ACCOUNTS_ACCESS_VERIFIERS, ACCOUNTS_API_KEY_AUTHENTICATOR } from './accounts.tokens';

/** Only explicitly annotated API endpoints can choose key authentication instead of a JWT session. */
export const ACCOUNT_API_KEY_SCOPES = Symbol.for('zucker:back-office:accounts:apiKeyScopes');
export const AccountApiKeyScopes = (...scopes: string[]) => SetMetadata(ACCOUNT_API_KEY_SCOPES, scopes);

/**
 * Global authentication of the account host (register as `APP_GUARD`): `@Public()` routes pass, routes
 * with `@AccountApiKeyScopes(...)` require an API key (never a JWT fallback), everything else needs
 * `Authorization: Bearer <access token>`. The token is verified with the configured audience and then
 * by each additional verifier in order; whichever succeeds, the session must still exist, be unrevoked
 * and unexpired, and match the account's credential version and sign-in method.
 */
@Injectable()
export class AccountGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService,
    private readonly accounts: AccountService, private readonly holder: AuthenticationHolder,
    @Optional() @Inject(ACCOUNTS_API_KEY_AUTHENTICATOR) private readonly apiKeys?: CanActivate,
    @Optional() @Inject(ACCOUNTS_ACCESS_VERIFIERS) private readonly verifiers: readonly AccountAccessTokenVerifier[] = []) {}

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
    const identity = await this.verify(header.slice(7));
    if (!identity) throw new UnauthorizedException();
    const user = await this.accounts.currentUser(identity.userId, identity.sessionId);
    req.user = { id: user.id, username: user.username, sid: identity.sessionId };
    req.auth = await this.holder.resolve({ request: req }) ?? fromJwtUser(req.user);
    return true;
  }

  /** Identity of a primary access token, else of the first additional verifier that accepts it. */
  async verify(token: string): Promise<AccountAccessIdentity | null> {
    try {
      const payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], audience: this.accounts.options.tokens.accessAudience });
      if (payload.tokenUse === 'access' && typeof payload.sub === 'string' && typeof payload.sid === 'string') return { userId: payload.sub, sessionId: payload.sid };
    } catch { /* not a primary token; try the additional verifiers */ }
    for (const verifier of this.verifiers) {
      try {
        const identity = await verifier.verify(token);
        if (identity && typeof identity.userId === 'string' && identity.userId && typeof identity.sessionId === 'string' && identity.sessionId) return identity;
      } catch { /* a verifier failure is a rejection, never a bypass */ }
    }
    return null;
  }
}
