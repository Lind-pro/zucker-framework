import { ExecutionContext, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

export interface OptionalJwtAuthOptions {
  /** Reject malformed/invalid supplied credentials while allowing absent headers. */
  invalidTokenPolicy?: 'anonymous' | 'reject';
}
export const OPTIONAL_JWT_AUTH_OPTIONS = Symbol.for('@zucker-framework/auth/optional-jwt-options');

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  constructor(@Optional() @Inject(OPTIONAL_JWT_AUTH_OPTIONS) private readonly options: OptionalJwtAuthOptions = {}) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
    }>();
    const authorization = request.headers.authorization;

    if (this.options.invalidTokenPolicy === 'reject') {
      if (authorization === undefined) return true;
      if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) {
        throw new UnauthorizedException();
      }
      return super.canActivate(context);
    }
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
      return true;
    }

    return super.canActivate(context);
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
