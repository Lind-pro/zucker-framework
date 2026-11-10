import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccountService } from '../accounts/account.service';

/**
 * Identity of an optional bearer on a `@Public()` route. The global AccountGuard skips public routes,
 * so this repeats its access-token checks (HS256, `zucker:access` audience, `tokenUse: access`, live
 * session). Any missing, malformed, expired or revoked token reads as anonymous: a public page must
 * never fail because of a stale browser token, and an anonymous answer reveals nothing.
 */
@Injectable()
export class OptionalViewer {
  constructor(private readonly jwt: JwtService, private readonly accounts: AccountService) {}

  async userId(authorization: unknown): Promise<string | null> {
    if (typeof authorization !== 'string' || !/^Bearer \S+$/i.test(authorization)) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: unknown; sid?: unknown; tokenUse?: unknown }>(authorization.slice(7),
        { algorithms: ['HS256'], audience: 'zucker:access' });
      if (payload.tokenUse !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      return (await this.accounts.currentUser(payload.sub, payload.sid)).id;
    } catch {
      return null;
    }
  }
}
