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
  IRateLimiterOptions,
} from 'rate-limiter-flexible';
import { BusinessException, NotFoundException } from '@zucker-framework/core';
import { createHmac } from 'node:crypto';
import type { Redis, RedisOptions } from 'ioredis';

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

export interface RateLimiterRedisOptions {
  url: string;
  commandTimeoutMs?: number;
  createClient?: (url: string, options: RedisOptions) => Redis | Promise<Redis>;
}

export interface RateLimiterModuleOptions {
  /** Externally owned client: observed, but never disconnected by this service. */
  redisClient?: unknown;
  /** Internally owned Redis connection. Mutually exclusive with redisClient. */
  redis?: RateLimiterRedisOptions;
  operationDeadlineMs?: number;
  circuitBreakerMs?: number;
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
  private readonly insuranceLimiters = new Map<string, RateLimiterMemory>();
  private useRedis = false;
  private redisClient: Redis | null = null;
  private redisDegraded = false;
  private redisRetryAt = 0;
  private redisResetPending = false;
  private shuttingDown = false;
  private initialization?: Promise<void>;
  private readonly onRedisError = (error: unknown) => this.markRedisDegraded('error', error);
  private readonly onRedisClose = () => this.markRedisDegraded('close');
  private readonly onRedisReady = () => {
    this.redisResetPending = false;
    this.markRedisRecovered();
  };

  constructor(private readonly options: RateLimiterModuleOptions) {}

  onModuleInit(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return (this.initialization ??= this.initialize());
  }

  private async initialize(): Promise<void> {
    if (this.options.redis && this.options.redisClient) {
      throw new Error('Configure redis or redisClient, not both');
    }
    if (this.options.redisClient) {
      this.redisClient = this.options.redisClient as Redis;
      this.useRedis = true;
      this.observeRedis();
    } else if (this.options.redis) {
      try {
        const { url, createClient, commandTimeoutMs } = this.options.redis;
        const create = createClient ?? (async (address: string, options: RedisOptions) => {
          const { default: Redis } = await import('ioredis');
          return new Redis(address, options);
        });
        this.redisClient = await create(url, {
          maxRetriesPerRequest: 3,
          commandTimeout: commandTimeoutMs ?? 500,
          lazyConnect: true,
          enableOfflineQueue: false,
          autoResendUnfulfilledCommands: false,
        });
        if (this.shuttingDown) {
          this.redisClient.disconnect(false);
          this.redisClient = null;
          return;
        }
        this.observeRedis();
        await this.redisClient.connect();
        this.useRedis = true;
      } catch (error) {
        this.markRedisDegraded('initial-connect', error);
        this.redisClient?.disconnect(false);
        this.redisClient = null;
      }
    }
    if (this.shuttingDown) return;

    for (const [name, config] of Object.entries(this.options.limiters)) {
      if (!Number.isFinite(config.points) || !Number.isFinite(config.duration) || config.points <= 0 || config.duration <= 0) {
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

      const insurance = new RateLimiterMemory(opts);
      this.insuranceLimiters.set(name, insurance);
      if (this.useRedis) {
        this.limiters.set(
          name,
          new RateLimiterRedis({
            ...opts,
            storeClient: this.redisClient,
            rejectIfRedisNotReady: true,
            keyPrefix: config.keyPrefix ?? `rl:${name}:`,
          }),
        );
      } else {
        this.limiters.set(name, insurance);
      }
    }

    this.logger.log(
      `RateLimiterService 初始化完成 (${this.useRedis ? 'Redis' : 'Memory'}), ${this.limiters.size} 个限流器`,
    );
  }

  onModuleDestroy(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.redisResetPending = false;
    this.redisClient?.removeListener?.('error', this.onRedisError);
    this.redisClient?.removeListener?.('close', this.onRedisClose);
    this.redisClient?.removeListener?.('ready', this.onRedisReady);
    if (this.options.redis) this.redisClient?.disconnect(false);
    this.redisClient = null;
    this.useRedis = false;
    this.limiters.clear();
    this.insuranceLimiters.clear();
  }

  private observeRedis(): void {
    this.redisClient?.on?.('error', this.onRedisError);
    this.redisClient?.on?.('close', this.onRedisClose);
    this.redisClient?.on?.('ready', this.onRedisReady);
  }

  private markRedisDegraded(event: string, error?: unknown): void {
    if (this.shuttingDown) return;
    this.redisRetryAt = Date.now() + (this.options.circuitBreakerMs ?? 5_000);
    if (this.redisDegraded) return;
    this.redisDegraded = true;
    const code = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(error.code)
      ? error.code : 'unknown';
    this.logger.warn(
      `Redis rate limiter degraded; using bounded in-process insurance limiter (event=${event}, code=${code})`,
    );
  }

  private markRedisRecovered(): void {
    if (this.shuttingDown || !this.redisDegraded) return;
    this.redisDegraded = false;
    this.redisRetryAt = 0;
    this.logger.log('Redis rate limiter recovered; distributed limits restored');
  }

  private async executeWithInsurance<T>(
    name: string,
    operation: (limiter: RateLimiterUnion) => Promise<T>,
  ): Promise<T> {
    const primary = this.getLimiter(name);
    const insurance = this.insuranceLimiters.get(name)!;
    if (!this.useRedis || primary === insurance ||
      (this.redisDegraded && Date.now() < this.redisRetryAt)) {
      return operation(insurance);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(Object.assign(new Error('Redis operation timed out'), {
        code: 'ETIMEDOUT',
      })), this.options.operationDeadlineMs ?? 750);
    });
    try {
      const result = await Promise.race([operation(primary), deadline]);
      this.markRedisRecovered();
      return result;
    } catch (error) {
      // RateLimiterRes is a rejection describing quota exhaustion, not an Error.
      // Never retry a distributed denial against a fresh insurance quota.
      if (!(error instanceof Error)) throw error;
      this.markRedisDegraded('command', error);
      if (this.options.redis && this.redisClient && !this.shuttingDown && !this.redisResetPending) {
        this.redisResetPending = true;
        this.redisClient.disconnect(true);
      }
      return operation(insurance);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
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
    this.getLimiter(limiterName);
    const storageKey = this.toStorageKey(key);

    if (pointsToConsume <= 0 || !Number.isFinite(pointsToConsume)) {
      throw new BusinessException(`消费点数无效: ${pointsToConsume}`, 'INVALID_POINTS', 400);
    }

    try {
      const res = await this.executeWithInsurance(limiterName, limiter => limiter.consume(storageKey, pointsToConsume));
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

  /** Atomic consumption with a per-subject cap, without allocating a limiter per subject.
   * Configure the named limiter's points at the maximum supported cap and blockDuration: 0.
   * Consumers own the subject/window key; rejected requests still advance the counter.
   */
  async checkLimit(
    limiterName: string,
    key: string,
    pointsLimit: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const configured = this.options.limiters[limiterName];
    this.getLimiter(limiterName);
    if (!Number.isFinite(pointsLimit) || pointsLimit <= 0 || pointsLimit > configured.points) {
      throw new BusinessException('Invalid subject rate limit', 'INVALID_POINTS', 400);
    }
    try {
      const result = await this.consume(limiterName, key);
      return {
        allowed: result.consumedPoints <= pointsLimit,
        remaining: Math.max(0, pointsLimit - result.consumedPoints),
        resetAt: new Date(Date.now() + result.msBeforeNext),
      };
    } catch (error) {
      if (!(error instanceof TooManyRequestsException)) throw error;
      return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + error.retryAfter * 1000) };
    }
  }

  /**
   * Apply a penalty by consuming extra points, extending the block time.
   * Useful for failed login attempts, abuse detection, etc.
   */
  async penalty(limiterName: string, key: string, points = 1): Promise<void> {
    await this.executeWithInsurance(limiterName, limiter => limiter.penalty(this.toStorageKey(key), points));
    this.logger.log(`限流惩罚: limiter=${limiterName}, points=${points}`);
  }

  /**
   * Reward by reducing consumed points (opposite of penalty).
   */
  async reward(limiterName: string, key: string, points = 1): Promise<void> {
    await this.executeWithInsurance(limiterName, limiter => limiter.reward(this.toStorageKey(key), points));
  }

  async getRemaining(
    limiterName: string,
    key: string,
  ): Promise<{ remaining: number; resetAt: Date }> {
    const res = await this.executeWithInsurance(limiterName, limiter => limiter.get(this.toStorageKey(key)));
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
    const storageKey = this.toStorageKey(key);
    await this.executeWithInsurance(limiterName, limiter => limiter.delete(storageKey));
    await this.insuranceLimiters.get(limiterName)!.delete(storageKey);
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
    return this.useRedis && !this.redisDegraded && !this.shuttingDown;
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
