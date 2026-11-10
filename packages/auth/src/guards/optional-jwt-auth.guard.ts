import { ExecutionContext, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TokenService } from '../services/token.service';
import { bearerToken, readAccessTokenClaims } from './access-token-claims';

export interface OptionalJwtAuthOptions {
  /** Reject malformed/invalid supplied credentials while allowing absent headers. */
  invalidTokenPolicy?: 'anonymous' | 'reject';
}
export const OPTIONAL_JWT_AUTH_OPTIONS = Symbol.for('@zucker-framework/auth/optional-jwt-options');

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    @Optional() @Inject(OPTIONAL_JWT_AUTH_OPTIONS) private readonly options: OptionalJwtAuthOptions = {},
    /** When available, revoked tokens are treated like invalid ones (anonymous or rejected). */
    @Optional() private readonly tokenService?: TokenService,
  ) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const result = this.activate(context);
    // Synchronous decisions (no/invalid header) stay synchronous; only a Passport-validated
    // credential is additionally checked against revocation.
    if (!this.tokenService || typeof result === 'boolean') return result;
    return result.then(async (ok) => {
      if (!ok) return ok;
      const request = context.switchToHttp().getRequest<{ headers: { authorization?: string }; user?: { id?: unknown } }>();
      const token = bearerToken(request.headers.authorization);
      if (!token || !request.user) return ok;
      const claims = readAccessTokenClaims(token);
      if (!claims.sub && typeof request.user.id === 'string') claims.sub = request.user.id;
      if (await this.tokenService!.checkAccessToken(token, claims)) {
        if (this.options.invalidTokenPolicy === 'reject') throw new UnauthorizedException();
        request.user = undefined;
      }
      return ok;
    });
  }

  private activate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
    }>();
    const authorization = request.headers.authorization;

    if (this.options.invalidTokenPolicy === 'reject') {
      if (authorization === undefined) return true;
      if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) {
        throw new UnauthorizedException();
      }
      return super.canActivate(context) as boolean | Promise<boolean>;
    }
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
      return true;
    }

    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  handleRequest<TUser>(error: unknown, user: TUser | null | false): TUser | null {
    if (this.options.invalidTokenPolicy === 'reject') {
      if (error) throw error;
      if (!user) throw new UnauthorizedException();
    }
    if (error || !user) return null;
    return user;
  }
}
