import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../decorators/rate-limit.decorator';
import { TooManyRequestsException } from '../rate-limiter.service';

/**
 * Route-level rate limiting driven by `@RateLimit`.
 *
 * Keys: the client IP (unchanged), `user:<id>`, `username:<name>`, `anon-ip:<address>`. User-keyed limits
 * (`#userId` / `#username`) need `request.user`, which is only set after the
 * authentication guard. When registered as a global `APP_GUARD` this guard runs before
 * controller-level auth guards, so prefer `globalGuard: false` with
 * `@UseGuards(AuthGuard, RateLimitGuard)` for user-keyed limits. Without a user the
 * request is limited under a separate `anon-ip:` bucket (never mixed with a user's
 * bucket), or rejected with 401 when `requireUser: true`.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly warned = new Set<string>();

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
    if (options.windowSeconds !== undefined || options.maxRequests !== undefined) {
      this.warnOnce(`window:${options.limiter}`,
        `@RateLimit windowSeconds/maxRequests are not applied; configure points/duration on limiter '${options.limiter}'`);
    }

    if (typeof this.rateLimiterService.has === 'function' && !this.rateLimiterService.has(options.limiter)) {
      // A decorator referencing a limiter that is not configured (e.g. the framework login's
      // `login`) must not turn every request into an error. Log once and allow.
      if (!this.warned.has(`missing:${options.limiter}`)) {
        this.warned.add(`missing:${options.limiter}`);
        this.logger.error(
          `@RateLimit('${options.limiter}') references a limiter that is not configured; the route is NOT rate limited. ` +
            `Add '${options.limiter}' to RateLimiterModule limiters.`,
        );
      }
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest();
    const key = this.extractKey(request, options);

    try {
      await this.rateLimiterService.consume(options.limiter, key);
      return true;
    } catch (err) {
      if (err instanceof TooManyRequestsException) {
        const response = http.getResponse?.();
        if (response && typeof response.setHeader === 'function' && !response.headersSent) {
          response.setHeader('Retry-After', String(Math.max(0, err.retryAfter)));
        } else if (response && typeof response.header === 'function') {
          response.header('Retry-After', String(Math.max(0, err.retryAfter)));
        }
        throw new TooManyRequestsException(options.message ?? 'Too many requests', err.retryAfter);
      }
      throw err;
    }
  }

  private extractKey(request: any, options: RateLimitOptions): string {
    const address = request.ip ?? request.socket?.remoteAddress ?? 'unknown-client';
    const extractor = options.keyExtractor ?? '#ip';
    if (extractor === '#ip') return address;
    const field = extractor === '#userId' ? 'id' : extractor === '#username' ? 'username' : undefined;
    if (!field) {
      this.warnOnce(`extractor:${extractor}`, `Unknown @RateLimit keyExtractor '${extractor}'; using client IP`);
      return address;
    }
    const value = request.user?.[field];
    if (value !== undefined && value !== null && value !== '') {
      return `${field === 'id' ? 'user' : 'username'}:${String(value)}`;
    }
    if (options.requireUser) throw new UnauthorizedException();
    this.warnOnce(`anon:${options.limiter}`,
      `@RateLimit('${options.limiter}') is keyed by ${extractor} but request.user is not set; ` +
      'the guard probably runs before authentication. Anonymous requests use a separate IP bucket.');
    return `anon-ip:${address}`;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}
