import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { BusinessException } from '@zucker-framework/core';
import { randomUUID } from 'node:crypto';
import type { RedisLike } from './cluster-manager';

/** Options for lock retry behavior in tryAcquire */
export interface LockRetryOptions {
  /** Total wait timeout in milliseconds */
  timeoutMs: number;
  /** Retry interval in milliseconds (default: 100) */
  retryIntervalMs?: number;
}

/** Options for {@link RedisDistributedLock.withLock}. */
export interface WithLockOptions {
  /**
   * Keep the lock alive while `fn` runs by renewing it every `renewIntervalMs`
   * (default: true). Without renewal a callback that outlives `ttl` silently
   * loses mutual exclusion. When a renewal fails (the lock expired or was
   * taken over) the `AbortSignal` passed to `fn` is aborted.
   */
  watchdog?: boolean;
  /** Renewal interval in milliseconds (default: ttl / 3, minimum 10ms). */
  renewIntervalMs?: number;
}

export interface DistributedLock {
  acquire(key: string, ttl: number): Promise<boolean>;
  release(key: string): Promise<void>;
  isLocked(key: string): Promise<boolean>;
  withLock<T>(
    key: string,
    ttl: number,
    fn: (signal: AbortSignal) => Promise<T>,
    options?: WithLockOptions,
  ): Promise<T>;

  /** 检查当前进程是否持有指定 key 的锁（同步） */
  isHeldByMe(key: string): boolean;

  /** 续期锁 TTL — 仅在当前进程持有时有效，返回是否续期成功 */
  renew(key: string, ttlMs: number): Promise<boolean>;

  /**
   * 带超时重试的锁获取 — 对应 jetlinks 中锁获取超时重试模式
   *
   * 在 timeoutMs 时间内以 retryIntervalMs 间隔重试获取锁。
   * @param key 锁键
   * @param ttl 锁 TTL（毫秒）
   * @param timeoutMs 总等待超时（毫秒）
   * @param retryIntervalMs 重试间隔（毫秒），默认 100ms
   * @returns 是否成功获取
   */
  tryAcquire?(key: string, ttl: number, timeoutMs: number, retryIntervalMs?: number): Promise<boolean>;
}

/** Compare-and-delete: only the holder of the token may delete the key. */
export const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Compare-and-pexpire: only the holder of the token may extend the TTL. */
export const RENEW_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

/**
 * Redis-backed distributed lock (single Redis instance, `SET NX PX` + Lua
 * compare-and-delete / compare-and-pexpire).
 *
 * Ownership is tracked per acquisition through an opaque token. Prefer
 * {@link acquireToken}/{@link releaseToken}/{@link renewToken} or
 * {@link withLock}: the key-based {@link acquire}/{@link release}/{@link renew}
 * API keeps one token per key per process, so two callers in the same process
 * sharing a key name cannot be told apart.
 *
 * The Redis client must support `EVAL` (ioredis does). Without it release and
 * renew fall back to a non-atomic GET + DEL/SET sequence and a warning is
 * logged once.
 */
@Injectable()
export class RedisDistributedLock implements DistributedLock, OnModuleDestroy {
  private readonly logger = new Logger(RedisDistributedLock.name);
  private redis: RedisLike | null = null;
  private lockPrefix = 'zucker:lock:';
  /** key -> token of the most recent acquisition through the key-based API. */
  private lockValues = new Map<string, string>();
  private warnedNoEval = false;

  async onModuleDestroy(): Promise<void> {
    // Release all locks held by this process on shutdown
    const entries = [...this.lockValues.entries()];
    for (const [key, token] of entries) {
      try {
        await this.releaseToken(key, token);
      } catch {
        // best-effort cleanup
      }
    }
    this.lockValues.clear();
  }

  configure(redis: RedisLike, prefix?: string): void {
    this.redis = redis;
    if (prefix) this.lockPrefix = prefix;
  }

  private requireRedis(): RedisLike {
    if (!this.redis) {
      throw new BusinessException('Redis not configured for distributed lock', 'LOCK_NOT_CONFIGURED', 500);
    }
    return this.redis;
  }

  /**
   * Acquire `key` for `ttl` ms. Returns a token that identifies this
   * acquisition, or `null` when the lock is held by someone else.
   */
  async acquireToken(key: string, ttl: number): Promise<string | null> {
    const redis = this.requireRedis();
    const lockKey = `${this.lockPrefix}${key}`;
    const token = randomUUID();
    const result = await redis.set(lockKey, token, 'PX', ttl, 'NX');
    if (!result) return null;
    this.lockValues.set(key, token);
    this.logger.debug(`Lock acquired: ${key}`);
    return token;
  }

  /**
   * Release `key` only if it is still held with `token`. Local state for this
   * token is always cleared. Returns whether the Redis key was deleted.
   */
  async releaseToken(key: string, token: string): Promise<boolean> {
    if (this.lockValues.get(key) === token) this.lockValues.delete(key);
    if (!this.redis) return false;
    const lockKey = `${this.lockPrefix}${key}`;
    const released = await this.compareAndRun(lockKey, token, RELEASE_LOCK_SCRIPT, []);
    if (released) this.logger.debug(`Lock released: ${key}`);
    return released;
  }

  /** Extend `key` to `ttlMs` only if it is still held with `token`. */
  async renewToken(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (!this.redis) return false;
    if (!ttlMs || ttlMs <= 0) return false;
    const lockKey = `${this.lockPrefix}${key}`;
    const renewed = await this.compareAndRun(lockKey, token, RENEW_LOCK_SCRIPT, [ttlMs]);
    if (!renewed && this.lockValues.get(key) === token) this.lockValues.delete(key);
    return renewed;
  }

  async acquire(key: string, ttl: number): Promise<boolean> {
    return (await this.acquireToken(key, ttl)) !== null;
  }

  async release(key: string): Promise<void> {
    const token = this.lockValues.get(key);
    if (!token) return;
    await this.releaseToken(key, token);
  }

  async isLocked(key: string): Promise<boolean> {
    if (!this.redis) return false;

    const lockKey = `${this.lockPrefix}${key}`;
    const value = await this.redis.get(lockKey);
    return value !== null;
  }

  isHeldByMe(key: string): boolean {
    return this.lockValues.has(key);
  }

  async renew(key: string, ttlMs: number): Promise<boolean> {
    const token = this.lockValues.get(key);
    if (!token) return false;
    return this.renewToken(key, token, ttlMs);
  }

  /**
   * Run `fn` while holding `key`. The lock is renewed in the background
   * (see {@link WithLockOptions.watchdog}) and released with this
   * acquisition's own token, so a stale `finally` can never delete a lock
   * that another caller acquired after expiry.
   */
  async withLock<T>(
    key: string,
    ttl: number,
    fn: (signal: AbortSignal) => Promise<T>,
    options: WithLockOptions = {},
  ): Promise<T> {
    const token = await this.acquireToken(key, ttl);
    if (!token) {
      throw new BusinessException(`无法获取锁: ${key}`, 'LOCK_ACQUIRE_FAILED', 409);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (options.watchdog !== false) {
      const interval = Math.max(10, options.renewIntervalMs ?? Math.floor(ttl / 3));
      let renewing = false;
      timer = setInterval(() => {
        if (renewing || controller.signal.aborted) return;
        renewing = true;
        this.renewToken(key, token, ttl)
          .then((ok) => {
            if (!ok) {
              this.logger.warn(`Lock lost while running critical section: ${key}`);
              controller.abort(new Error(`Lock lost: ${key}`));
              if (timer) clearInterval(timer);
            }
          })
          .catch((err: unknown) => {
            // Transient Redis error: keep trying until the TTL actually lapses.
            this.logger.warn(`Lock renewal failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            renewing = false;
          });
      }, interval);
      timer.unref?.();
    }

    try {
      return await fn(controller.signal);
    } finally {
      if (timer) clearInterval(timer);
      try {
        await this.releaseToken(key, token);
      } catch (err) {
        // The lock expires on its own; do not mask fn's result/error.
        this.logger.warn(`Lock release failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * tryAcquire — 带超时重试的锁获取
   * 在 timeoutMs 内以 retryIntervalMs 间隔轮询尝试获取锁。
   */
  async tryAcquire(
    key: string,
    ttl: number,
    timeoutMs: number,
    retryIntervalMs = 100,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const acquired = await this.acquire(key, ttl);
      if (acquired) return true;
      // 等待一个间隔后重试
      await new Promise<void>((resolve) => setTimeout(resolve, retryIntervalMs));
    }
    return false;
  }

  private async compareAndRun(
    lockKey: string,
    token: string,
    script: string,
    extraArgs: number[],
  ): Promise<boolean> {
    const redis = this.redis!;
    if (typeof redis.eval === 'function') {
      const result = await redis.eval(script, 1, lockKey, token, ...extraArgs);
      return Number(result) === 1;
    }
    if (!this.warnedNoEval) {
      this.warnedNoEval = true;
      this.logger.warn('Redis client has no eval(); distributed lock release/renew is not atomic');
    }
    const current = await redis.get(lockKey);
    if (current !== token) return false;
    if (script === RELEASE_LOCK_SCRIPT) {
      await redis.del(lockKey);
    } else {
      await redis.set(lockKey, token, 'PX', extraArgs[0], 'XX');
    }
    return true;
  }
}
