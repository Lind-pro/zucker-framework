import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  IRateLimiterOptions,
} from 'rate-limiter-flexible';
import { BusinessException, NotFoundException } from '@zucker-framework/core';
import { createHmac } from 'node:crypto';

type RateLimiterUnion = RateLimiterMemory | RateLimiterRedis;

export interface LimiterConfig {
  /** Maximum number of points allowed in the duration window */
  points: number;
  /** Duration of the window in seconds */
  duration: number;
  /** Block duration in seconds when limit is exceeded (defaults to duration) */
  blockDuration?: number;
  /** Key prefix for Redis storage */
  keyPrefix?: string;
}

export interface RateLimiterModuleOptions {
  redisClient?: unknown;
  /** Optional secret used to HMAC consumer keys before memory/Redis storage. */
  keyHashSecret?: string;
  /** Register the rate-limit guard globally. Set false when guard ordering matters. */
  globalGuard?: boolean;
  limiters: Record<string, LimiterConfig>;
}

export function deriveRateLimitKey(key: string, secret?: string): string {
  if (!secret) return key;
  return `v1:${createHmac('sha256', secret).update(key).digest('hex')}`;
}

/** Result returned from consume with remaining quota info */
export interface ConsumeResult {
  remaining: number;
  msBeforeNext: number;
  consumedPoints: number;
}

/** Exception thrown when rate limit is exceeded (HTTP 429) */
export class TooManyRequestsException extends HttpException {
  public readonly retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message, retryAfter },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.retryAfter = retryAfter;
  }
}

@Injectable()
export class RateLimiterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly limiters = new Map<string, RateLimiterUnion>();
  private useRedis = false;

  constructor(private readonly options: RateLimiterModuleOptions) {}

  async onModuleInit() {
    if (this.options.redisClient) {
      this.useRedis = true;
      this.logger.log('RateLimiterService 使用 Redis 分布式限流');
    }

    for (const [name, config] of Object.entries(this.options.limiters)) {
      if (config.points <= 0 || config.duration <= 0) {
        this.logger.warn(
          `限流器 '${name}' 配置无效 (points=${config.points}, duration=${config.duration})，已跳过`,
        );
        continue;
      }

      const opts: IRateLimiterOptions = {
        points: config.points,
        duration: config.duration,
        blockDuration: config.blockDuration ?? config.duration,
      };

      if (this.useRedis) {
        this.limiters.set(
          name,
          new RateLimiterRedis({
            ...opts,
            storeClient: this.options.redisClient,
            keyPrefix: config.keyPrefix ?? `rl:${name}:`,
          }),
        );
      } else {
        this.limiters.set(name, new RateLimiterMemory(opts));
      }
    }

    this.logger.log(
      `RateLimiterService 初始化完成 (${this.useRedis ? 'Redis' : 'Memory'}), ${this.limiters.size} 个限流器`,
    );
  }

  onModuleDestroy(): void {
    this.limiters.clear();
    this.logger.log('RateLimiterService 已清理');
  }

  /**
   * Consume points from a rate limiter.
   * Throws TooManyRequestsException (429) when limit is exceeded.
   */
  async consume(
    limiterName: string,
    key: string,
    pointsToConsume = 1,
    errorMessage = '请求过于频繁，请稍后再试',
  ): Promise<ConsumeResult> {
    const limiter = this.getLimiter(limiterName);
    const storageKey = this.toStorageKey(key);

    if (pointsToConsume <= 0 || !Number.isFinite(pointsToConsume)) {
      throw new BusinessException(`消费点数无效: ${pointsToConsume}`, 'INVALID_POINTS', 400);
    }

    try {
      const res = await limiter.consume(storageKey, pointsToConsume);
      return {
        remaining: res.remainingPoints,
        msBeforeNext: res.msBeforeNext,
        consumedPoints: res.consumedPoints,
      };
    } catch (error) {
      // rate-limiter-flexible 限流时抛出的是 RateLimiterRes 对象（含 msBeforeNext）
      if (error && typeof error === 'object' && 'msBeforeNext' in error) {
        const res = error as {
          msBeforeNext: number;
          remainingPoints: number;
          consumedPoints: number;
        };
        const retryAfter = Math.ceil(res.msBeforeNext / 1000);
        this.logger.warn(`限流触发: limiter=${limiterName}, retryAfter=${retryAfter}s`);
        throw new TooManyRequestsException(errorMessage, retryAfter);
      }
      // 其他错误（连接失败等）直接抛出
      throw error;
    }
  }

  /**
   * Apply a penalty by consuming extra points, extending the block time.
   * Useful for failed login attempts, abuse detection, etc.
   */
  async penalty(limiterName: string, key: string, points = 1): Promise<void> {
    const limiter = this.getLimiter(limiterName);
    await limiter.penalty(this.toStorageKey(key), points);
    this.logger.log(`限流惩罚: limiter=${limiterName}, points=${points}`);
  }

  /**
   * Reward by reducing consumed points (opposite of penalty).
   */
  async reward(limiterName: string, key: string, points = 1): Promise<void> {
    const limiter = this.getLimiter(limiterName);
    await limiter.reward(this.toStorageKey(key), points);
  }

  async getRemaining(
    limiterName: string,
    key: string,
  ): Promise<{ remaining: number; resetAt: Date }> {
    const limiter = this.getLimiter(limiterName);

    const res = await limiter.get(this.toStorageKey(key));
    if (!res) {
      const config = this.options.limiters[limiterName];
      return {
        remaining: config.points,
        resetAt: new Date(Date.now() + config.duration * 1000),
      };
    }

    return {
      remaining: res.remainingPoints,
      resetAt: new Date(Date.now() + res.msBeforeNext),
    };
  }

  async reset(limiterName: string, key: string): Promise<void> {
    const limiter = this.getLimiter(limiterName);
    await limiter.delete(this.toStorageKey(key));
  }

  /**
   * Convenience method for public API rate limiting.
   * Consumes 1 point from the named limiter using the given key.
   * Throws TooManyRequestsException (429) when limit is exceeded.
   *
   * @param key - Unique identifier for the consumer (e.g., IP address)
   * @param limiterName - Name of the registered rate limiter
   */
  async checkPublicApiLimit(key: string, limiterName: string): Promise<void> {
    await this.consume(limiterName, key, 1, '请求过于频繁，请稍后再试');
  }

  /**
   * Check AI operation rate limit for a user.
   * Falls back gracefully if the limiter doesn't exist (AI ops are best-effort limited).
   *
   * @param userId - User identifier
   * @param operation - Human-readable description of the AI operation
   * @param points - Points to consume (default: 1)
   */
  async checkAILimit(userId: string, operation: string, points = 1): Promise<void> {
    const limiterName = 'ai-default';
    if (!this.has(limiterName)) return; // graceful: if no AI limiter configured, skip
    await this.consume(
      limiterName,
      userId,
      points,
      `AI 操作"${operation}"请求过于频繁，请稍后再试`,
    );
  }

  /** Check if a limiter exists by name */
  has(limiterName: string): boolean {
    return this.limiters.has(limiterName);
  }

  /** Get all registered limiter names */
  getLimiterNames(): string[] {
    return [...this.limiters.keys()];
  }

  isDistributed(): boolean {
    return this.useRedis;
  }

  /** Get a limiter by name, throwing if not found */
  private getLimiter(limiterName: string): RateLimiterUnion {
    const limiter = this.limiters.get(limiterName);
    if (!limiter) {
      throw new NotFoundException(
        `限流器 '${limiterName}' 不存在 (可用: ${this.getLimiterNames().join(', ')})`,
      );
    }
    return limiter;
  }

  private toStorageKey(key: string): string {
    return deriveRateLimitKey(key, this.options.keyHashSecret);
  }
}
