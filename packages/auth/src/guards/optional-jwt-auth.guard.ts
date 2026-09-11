import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  constructor() {
    super();
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
    }>();
    const authorization = request.headers.authorization;

    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest<TUser>(error: unknown, user: TUser | null | false): TUser | null {
    if (error || !user) return null;
    return user;
  }
}
