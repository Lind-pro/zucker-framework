import { RedisCache, type RedisClient } from "./redis-cache";
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import type { Redis, RedisOptions } from "ioredis";

export interface RedisCacheServiceOptions {
  /** No URL means disabled. The consumer owns environment configuration. */
  url?: string;
  commandTimeoutMs?: number;
  operationDeadlineMs?: number;
  circuitBreakerMs?: number;
  /** Optional factory for a compatible client, including isolated adapter tests. */
  createClient?: (url: string, options: RedisOptions) => Redis | Promise<Redis>;
  /**
   * Prefix applied to every key, e.g. `"ccopyright:"`. Defaults to `""` (keys unchanged)
   * so existing deployments keep reading their data; set it when products share a Redis DB.
   */
  keyPrefix?: string;
  /**
   * Maximum number of keys remembered for invalidation while Redis is degraded.
   * They are deleted from Redis as soon as it is reachable again. Default 10_000.
   */
  maxPendingInvalidations?: number;
}

/** INCR and set the TTL atomically; also repairs a counter left without expiry. */
const INCR_WITH_TTL_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
local ttl = tonumber(ARGV[1])
if ttl and ttl > 0 and redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return v`;

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
  /**
   * Keys whose Redis copy became stale while Redis was unreachable (delete/set fell back
   * to memory). They are deleted before any other command once Redis is back, so an
   * invalidation issued during an outage cannot be undone by the old Redis value.
   */
  private readonly pendingInvalidations = new Set<string>();
  private pendingOverflowWarned = false;

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
      const result = await Promise.race([this.replayInvalidations().then(command), deadline]);
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

  /** Remember a key whose Redis value must not survive the current outage. */
  markStale(key: string): void {
    if (!this.options.url || this.shuttingDown) return;
    const max = this.options.maxPendingInvalidations ?? 10_000;
    if (this.pendingInvalidations.size >= max && !this.pendingInvalidations.has(key)) {
      if (!this.pendingOverflowWarned) {
        this.pendingOverflowWarned = true;
        this.logger.warn(`Redis invalidation backlog full (${max}); later keys rely on TTL expiry`);
      }
      return;
    }
    this.pendingInvalidations.add(key);
  }

  /** Number of invalidations waiting for Redis to recover (diagnostics and tests). */
  get pendingInvalidationCount(): number {
    return this.pendingInvalidations.size;
  }

  private async replayInvalidations(): Promise<void> {
    if (this.pendingInvalidations.size === 0 || !this.client) return;
    const keys = [...this.pendingInvalidations];
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500);
      await this.client.del(...batch.map((k) => this.prefixed(k)));
      for (const k of batch) this.pendingInvalidations.delete(k);
    }
    this.pendingOverflowWarned = false;
  }

  private prefixed(key: string): string {
    return `${this.options.keyPrefix ?? ''}${key}`;
  }

  private cache<T>(): RedisCache<T> {
    return new RedisCache<T>(this.client as unknown as RedisClient, {
      prefix: this.options.keyPrefix ?? '',
    });
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
   * @param ttlSeconds 过期时间（秒）。非正数或非有限数表示"立即过期"：删除旧值而不是保留它。
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!this.isAvailable()) {
      this.markStale(key);
      return;
    }
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      // Never translate an invalid TTL to an immortal key, and never leave the old value.
      await this.delete(key);
      return;
    }
    const ttlMs = Math.max(1, Math.ceil(ttlSeconds * 1000));
    const ok = await this.runCommand(async () => {
      await this.cache().set(key, value, ttlMs);
      return true;
    }, false);
    if (!ok) this.markStale(key);
  }

  /**
   * 获取缓存
   * @param key 缓存键
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) return null;
    const raw = await this.runCommand(() => this.client!.get(this.prefixed(key)), null);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt value is a miss for this key, not a connection failure.
      this.logger.warn('Redis cache value is not valid JSON; treating it as a miss');
      return null;
    }
  }

  /**
   * 删除缓存。Redis 不可用时记录待删除键，恢复后先删除再执行其它命令。
   * @param key 缓存键
   */
  async delete(key: string): Promise<void> {
    if (!this.isAvailable()) {
      this.markStale(key);
      return;
    }
    const ok = await this.runCommand(async () => {
      await this.cache().del(key);
      return true;
    }, false);
    if (!ok) this.markStale(key);
  }

  /**
   * 递增计数器（INCR 与 EXPIRE 原子执行）
   * @param key 缓存键
   * @param ttlSeconds 首次设置时的 TTL（秒）
   * @returns 递增后的值；Redis 不可用时返回 0
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }
    const ttl = ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.ceil(ttlSeconds) : 0;
    const client = this.client!;
    const fullKey = this.prefixed(key);
    return this.runCommand(async () => {
      if (typeof client.eval === 'function') {
        return Number(await client.eval(INCR_WITH_TTL_SCRIPT, 1, fullKey, ttl));
      }
      // Compatible clients without EVAL: still never leave a counter without TTL.
      const value = await client.incr(fullKey);
      if (ttl > 0 && (value === 1 || (await client.ttl(fullKey)) === -1)) {
        await client.expire(fullKey, ttl);
      }
      return value;
    }, 0);
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

    return this.runCommand(() => this.client!.ttl(this.prefixed(key)), -2);
  }

  /**
   * 检查 key 是否存在
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return this.runCommand(() => this.cache().has(key), false);
  }
}
