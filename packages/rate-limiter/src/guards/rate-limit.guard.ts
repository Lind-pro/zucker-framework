import { Injectable, CanActivate, ExecutionContext, Inject, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../decorators/rate-limit.decorator';
import { TooManyRequestsException } from '../rate-limiter.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject('RATE_LIMITER_SERVICE') @Optional() private readonly rateLimiterService: any,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options || !this.rateLimiterService) return true;

    const request = context.switchToHttp().getRequest();
    const key = this.extractKey(request, options);

    try {
      await this.rateLimiterService.consume(options.limiter, key);
      return true;
    } catch (err) {
      if (err instanceof TooManyRequestsException) {
        throw new TooManyRequestsException(
          options.message ?? 'Too many requests',
          err.retryAfter,
        );
      }
      throw err;
    }
  }

  private extractKey(request: any, options: RateLimitOptions): string {
    switch (options.keyExtractor) {
      case '#userId': return request.user?.id ?? request.ip;
      case '#username': return request.user?.username ?? request.ip;
      default: return request.ip;
    }
  }
}
