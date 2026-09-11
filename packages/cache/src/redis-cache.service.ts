import { RedisCache, type RedisClient } from "./redis-cache";
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import type Redis from "ioredis";
import type { RedisOptions } from "ioredis";

export interface RedisCacheServiceOptions {
  /** No URL means disabled. The consumer owns environment configuration. */
  url?: string;
  commandTimeoutMs?: number;
  operationDeadlineMs?: number;
  circuitBreakerMs?: number;
  /** Optional factory for a compatible client, including isolated adapter tests. */
  createClient?: (url: string, options: RedisOptions) => Redis | Promise<Redis>;
}

class RedisOperationTimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor() {
    super("Redis operation timed out");
  }
}

/** Best-effort Redis cache. Misses return null, and TTL arguments are seconds.
 * Owns exactly one connection. Timed-out commands cannot remain queued or replayed.
 */
@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private client: Redis | null = null;
  private isConnected = false;
  private redisDegradedUntil = 0;
  private connectionResetPending = false;
  private shuttingDown = false;

  private initialization?: Promise<void>;

  constructor(private readonly options: RedisCacheServiceOptions = {}) {}

  onModuleInit(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return (this.initialization ??= this.initialize());
  }

  private async initialize(): Promise<void> {
    const redisUrl = this.options.url;
    if (!redisUrl) return;

    try {
      const createClient = this.options.createClient ?? (async (url: string, options: RedisOptions) => {
        const { default: Redis } = await import('ioredis');
        return new Redis(url, options);
      });
      this.client = await createClient(redisUrl, {
        maxRetriesPerRequest: 3,
        commandTimeout: this.options.commandTimeoutMs ?? 500,
        lazyConnect: true,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });

      if (this.shuttingDown) {
        this.client.disconnect(false);
        this.client = null;
        return;
      }
      this.client.on("ready", () => {
        if (this.shuttingDown) return;
        this.connectionResetPending = false;
        this.isConnected = true;
        this.logger.debug("Redis 连接成功");
      });

      this.client.on("error", (err) => {
        if (this.shuttingDown) return;
        this.isConnected = false;
        this.logger.warn(`Redis connection error (code=${this.errorCode(err)})`);
      });

      this.client.on("close", () => {
        if (this.shuttingDown) return;
        this.isConnected = false;
        this.logger.warn("Redis 连接已关闭");
      });

      await this.client.connect();
    } catch (error) {
      this.logger.error(
        `Redis initialization failed (code=${this.errorCode(error)})`,
      );
    }
  }

  onModuleDestroy(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.isConnected = false;
    this.connectionResetPending = false;
    this.client?.disconnect(false);
    this.client = null;
    this.logger.debug("Redis 连接已关闭");
  }

  /**
   * 检查 Redis 是否可用
   */
  isAvailable(): boolean {
    return (
      this.isConnected &&
      this.client !== null &&
      Date.now() >= this.redisDegradedUntil
    );
  }

  private async runCommand<T>(
    command: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    if (!this.isAvailable()) {
      return fallback;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new RedisOperationTimeoutError());
      }, this.options.operationDeadlineMs ?? 750);
    });

    try {
      const result = await Promise.race([command(), deadline]);
      this.redisDegradedUntil = 0;
      return result;
    } catch (error) {
      this.redisDegradedUntil = Date.now() + (this.options.circuitBreakerMs ?? 5_000);
      this.resetConnection();
      this.logger.warn(
        `Redis cache degraded; using authoritative fallback (code=${this.errorCode(error)})`,
      );
      return fallback;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private errorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(error.code)
      ? error.code : 'unknown';
  }

  private resetConnection(): void {
    if (!this.client || this.shuttingDown || this.connectionResetPending) {
      return;
    }

    this.connectionResetPending = true;
    this.isConnected = false;
    this.client.disconnect(true);
  }

  /**
   * 设置缓存（带 TTL）
   * @param key 缓存键
   * @param value 缓存值
   * @param ttlSeconds 过期时间（秒）
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    // SETEX rejected non-positive/fractional TTLs; never translate them to immortal keys.
    if (!this.isAvailable() || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0)
      return;
    await this.runCommand(
      () =>
        new RedisCache(this.client as unknown as RedisClient, {
          prefix: "",
        }).set(key, value, ttlSeconds * 1000),
      undefined,
    );
  }

  /**
   * 获取缓存
   * @param key 缓存键
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) return null;
    return (
      (await this.runCommand(
        () =>
          new RedisCache<T>(this.client as unknown as RedisClient, {
            prefix: "",
          }).get(key),
        undefined,
      )) ?? null
    );
  }

  /**
   * 删除缓存
   * @param key 缓存键
   */
  async delete(key: string): Promise<void> {
    if (!this.isAvailable()) return;
    await this.runCommand(
      () =>
        new RedisCache(this.client as unknown as RedisClient, {
          prefix: "",
        }).del(key),
      undefined,
    );
  }

  /**
   * 递增计数器
   * @param key 缓存键
   * @param ttlSeconds 首次设置时的 TTL
   * @returns 递增后的值
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    const value = await this.runCommand(() => this.client!.incr(key), 0);

    // 如果是新 key，设置 TTL
    if (value === 1 && ttlSeconds) {
      await this.runCommand(async () => {
        await this.client!.expire(key, ttlSeconds);
      }, undefined);
    }

    return value;
  }

  /**
   * 获取剩余 TTL
   * @param key 缓存键
   * @returns 剩余秒数，-1 表示永不过期，-2 表示不存在
   */
  async ttl(key: string): Promise<number> {
    if (!this.isAvailable()) {
      return -2;
    }

    return this.runCommand(() => this.client!.ttl(key), -2);
  }

  /**
   * 检查 key 是否存在
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return this.runCommand(
      () =>
        new RedisCache(this.client as unknown as RedisClient, {
          prefix: "",
        }).has(key),
      false,
    );
  }
}
