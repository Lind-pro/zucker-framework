import {
  ExecutionContext,
  Injectable,
  Optional,
} from '@nestjs/common';
import { UnauthorizedException } from '@zucker-framework/core';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/constants';
import { TokenService } from '../services/token.service';
import { AuthenticationHolder } from '../authentication/authentication-holder';
import { fromJwtUser } from '../authentication/default-authentication';
import { bearerToken, readAccessTokenClaims } from './access-token-claims';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private tokenService: TokenService,
    @Optional() private authenticationHolder?: AuthenticationHolder,
  ) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Passport may accept trailing header fields, while blacklist lookup uses the
    // whole credential. Reject ambiguous headers before those two paths diverge.
    const authorization = context.switchToHttp().getRequest().headers?.authorization;
    if (authorization !== undefined &&
        (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization))) {
      throw new UnauthorizedException('Invalid authorization header');
    }

    // Execute JWT validation first, then check blacklist and build Authentication
    const parentResult = super.canActivate(context);

    if (parentResult instanceof Observable) {
      return parentResult;
    }

    if (parentResult instanceof Promise) {
      return parentResult.then((result) => {
        if (!result) return false;
        return this.postValidate(context);
      });
    }

    if (!parentResult) return false;
    return this.postValidate(context);
  }

  private async postValidate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Revocation: blacklist, non-NORMAL session state, and the per-user watermark
    // (kick / disable / password change). The watermark is keyed by the verified `sub`.
    const token = bearerToken(request.headers?.authorization);
    if (token) {
      const claims = readAccessTokenClaims(token);
      if (!claims.sub && request.user && typeof request.user.id === 'string') {
        claims.sub = request.user.id;
      }
      const rejection = await this.tokenService.checkAccessToken(token, claims);
      if (rejection) {
        throw new UnauthorizedException('Token 已被撤销');
      }
      await this.tokenService.touch(token);
    }

    // Build full Authentication instance via AuthenticationHolder
    if (this.authenticationHolder && request.user) {
      const auth = await this.authenticationHolder.resolve({ request });
      if (auth) {
        request.auth = auth;
      } else {
        // Fallback: wrap the JWT user as a basic Authentication
        request.auth = fromJwtUser(request.user);
      }
    } else if (request.user) {
      // No holder registered — wrap JWT user for backward compat
      request.auth = fromJwtUser(request.user);
    }

    return true;
  }
}
