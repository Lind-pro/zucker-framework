import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'ZUCKER_RATE_LIMIT';

export interface RateLimitOptions {
  /** 限流器名称 */
  limiter: string;
  /**
   * @deprecated Not applied. The window comes from the named limiter's `duration`
   * in `ZuckerRateLimiterModule.forRoot({ limiters })`.
   */
  windowSeconds?: number;
  /**
   * @deprecated Not applied. The quota comes from the named limiter's `points`.
   */
  maxRequests?: number;
  /** 自定义 key 提取 (默认用 IP) */
  keyExtractor?: string; // '#ip' | '#userId' | '#username'
  /**
   * For `#userId` / `#username`: reject with 401 when `request.user` is missing instead of
   * limiting the request under a separate anonymous per-IP bucket.
   */
  requireUser?: boolean;
  /** 自定义消息 */
  message?: string;
}

/**
 * @RateLimit — 路由级限流装饰器
 * 对标 Spring @RateLimit
 */
export function RateLimit(options: RateLimitOptions | string): MethodDecorator & ClassDecorator {
  const opts = typeof options === 'string' ? { limiter: options } : options;
  return SetMetadata(RATE_LIMIT_KEY, opts);
}
