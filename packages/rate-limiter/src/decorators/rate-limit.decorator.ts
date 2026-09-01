import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'ZUCKER_RATE_LIMIT';

export interface RateLimitOptions {
  /** 限流器名称 */
  limiter: string;
  /** 时间窗口(秒) */
  windowSeconds?: number;
  /** 最大请求数 */
  maxRequests?: number;
  /** 自定义 key 提取 (默认用 IP) */
  keyExtractor?: string; // '#ip' | '#userId' | '#username'
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
