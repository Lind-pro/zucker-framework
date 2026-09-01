import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { BusinessException } from '@zucker/core';
import type { RedisLike } from './cluster-manager';

/** Options for lock retry behavior in tryAcquire */
export interface LockRetryOptions {
  /** Total wait timeout in milliseconds */
  timeoutMs: number;
  /** Retry interval in milliseconds (default: 100) */
  retryIntervalMs?: number;
}

export interface DistributedLock {
  acquire(key: string, ttl: number): Promise<boolean>;
  release(key: string): Promise<void>;
  isLocked(key: string): Promise<boolean>;
  withLock<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T>;

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

@Injectable()
export class RedisDistributedLock implements DistributedLock, OnModuleDestroy {
  private readonly logger = new Logger(RedisDistributedLock.name);
  private redis: RedisLike | null = null;
  private lockPrefix = 'zucker:lock:';
  private lockValues = new Map<string, string>();

  async onModuleDestroy(): Promise<void> {
    // Release all locks held by this process on shutdown
    const keys = [...this.lockValues.keys()];
    for (const key of keys) {
      try {
        await this.release(key);
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

  async acquire(key: string, ttl: number): Promise<boolean> {
    if (!this.redis) {
      throw new BusinessException('Redis not configured for distributed lock', 'LOCK_NOT_CONFIGURED', 500);
    }

    const lockKey = `${this.lockPrefix}${key}`;
    const lockValue = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // SETNX with TTL
    const result = await this.redis.set(lockKey, lockValue, 'PX', ttl, 'NX');

    if (result) {
      this.lockValues.set(key, lockValue);
      this.logger.debug(`Lock acquired: ${key}`);
      return true;
    }

    return false;
  }

  async release(key: string): Promise<void> {
    if (!this.redis) return;

    const lockKey = `${this.lockPrefix}${key}`;
    const lockValue = this.lockValues.get(key);

    if (!lockValue) return;

    // 验证锁持有者后才释放（防止误删其他进程的锁）
    const currentValue = await this.redis.get(lockKey);
    if (currentValue === lockValue) {
      await this.redis.del(lockKey);
      this.lockValues.delete(key);
      this.logger.debug(`Lock released: ${key}`);
    }
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
    if (!this.redis) return false;
    if (!ttlMs || ttlMs <= 0) return false;
    const lockValue = this.lockValues.get(key);
    if (!lockValue) return false;

    const lockKey = `${this.lockPrefix}${key}`;
    const currentValue = await this.redis.get(lockKey);
    if (currentValue !== lockValue) {
      this.lockValues.delete(key);
      return false;
    }

    await this.redis.set(lockKey, lockValue, 'PX', ttlMs);
    return true;
  }

  async withLock<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const acquired = await this.acquire(key, ttl);
    if (!acquired) {
      throw new BusinessException(`无法获取锁: ${key}`, 'LOCK_ACQUIRE_FAILED', 409);
    }

    try {
      return await fn();
    } finally {
      await this.release(key);
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
}
