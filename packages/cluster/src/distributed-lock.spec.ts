import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisDistributedLock } from './distributed-lock';
import type { RedisLike } from './cluster-manager';

function createMockRedis(): RedisLike & { store: Map<string, { value: string; expiresAt: number }> } {
  const store = new Map<string, { value: string; expiresAt: number }>();

  const redis: any = {
    store,
    async set(key: string, value: string, _px: string, ttl: number, _nx: string) {
      if (store.has(key)) {
        const entry = store.get(key)!;
        if (Date.now() < entry.expiresAt) return null; // key exists, NX fails
        store.delete(key);
      }
      store.set(key, { value, expiresAt: Date.now() + ttl });
      return 'OK';
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async del(...keys: string[]) {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
    async eval(script: string, _numkeys: number, key: string, ...args: any[]) {
      const entry = store.get(key);
      if (!entry) return 0;
      // Release script: check value match then delete
      if (script.includes('del')) {
        if (entry.value === args[0]) {
          store.delete(key);
          return 1;
        }
        return 0;
      }
      // Renew script: check value match then pexpire
      if (script.includes('pexpire')) {
        if (entry.value === args[0]) {
          entry.expiresAt = Date.now() + Number(args[1]);
          return 1;
        }
        return 0;
      }
      return 0;
    },
    async pexpire(key: string, ms: number) {
      const entry = store.get(key);
      if (entry) {
        entry.expiresAt = Date.now() + ms;
        return 1;
      }
      return 0;
    },
    async hset() { return 1; },
    async hget() { return null; },
    async hdel() { return 1; },
    async hgetall() { return {}; },
    async publish() { return 0; },
    async subscribe() {},
    async unsubscribe() {},
    on() { return redis; },
    duplicate() { return redis; },
  };
  return redis;
}

describe('RedisDistributedLock', () => {
  let lock: RedisDistributedLock;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    lock = new RedisDistributedLock();
    redis = createMockRedis();
    lock.configure(redis);
  });

  it('should acquire lock successfully', async () => {
    const acquired = await lock.acquire('resource-1', 5000);
    expect(acquired).toBe(true);
  });

  it('should fail to acquire already held lock', async () => {
    await lock.acquire('resource-1', 5000);
    // Create a second lock instance to simulate another process
    const lock2 = new RedisDistributedLock();
    lock2.configure(redis);
    const acquired = await lock2.acquire('resource-1', 5000);
    expect(acquired).toBe(false);
  });

  it('should release lock successfully', async () => {
    await lock.acquire('resource-1', 5000);
    await lock.release('resource-1');
    // Now another lock should be able to acquire
    const lock2 = new RedisDistributedLock();
    lock2.configure(redis);
    const acquired = await lock2.acquire('resource-1', 5000);
    expect(acquired).toBe(true);
  });

  it('should report isLocked correctly', async () => {
    expect(await lock.isLocked('resource-1')).toBe(false);
    await lock.acquire('resource-1', 5000);
    expect(await lock.isLocked('resource-1')).toBe(true);
    await lock.release('resource-1');
    expect(await lock.isLocked('resource-1')).toBe(false);
  });

  it('should report isHeldByMe correctly', async () => {
    expect(lock.isHeldByMe('resource-1')).toBe(false);
    await lock.acquire('resource-1', 5000);
    expect(lock.isHeldByMe('resource-1')).toBe(true);
    await lock.release('resource-1');
    expect(lock.isHeldByMe('resource-1')).toBe(false);
  });

  it('should throw when redis is not configured', async () => {
    const unconfiguredLock = new RedisDistributedLock();
    await expect(unconfiguredLock.acquire('key', 1000)).rejects.toThrow('Redis not configured');
  });

  it('should execute withLock and release after', async () => {
    const result = await lock.withLock('resource-1', 5000, async () => {
      expect(lock.isHeldByMe('resource-1')).toBe(true);
      return 'done';
    });
    expect(result).toBe('done');
    expect(lock.isHeldByMe('resource-1')).toBe(false);
  });

  it('should throw when withLock cannot acquire', async () => {
    // Pre-acquire the lock with another instance
    const lock2 = new RedisDistributedLock();
    lock2.configure(redis);
    await lock2.acquire('resource-1', 5000);

    await expect(
      lock.withLock('resource-1', 5000, async () => 'should not run'),
    ).rejects.toThrow('无法获取锁');
  });

  it('should release lock even when withLock callback throws', async () => {
    await expect(
      lock.withLock('resource-1', 5000, async () => {
        throw new Error('callback error');
      }),
    ).rejects.toThrow('callback error');
    expect(lock.isHeldByMe('resource-1')).toBe(false);
  });

  it('should renew lock TTL', async () => {
    await lock.acquire('resource-1', 1000);
    const renewed = await lock.renew('resource-1', 5000);
    expect(renewed).toBe(true);
  });

  it('should fail to renew lock not held', async () => {
    const renewed = await lock.renew('resource-1', 5000);
    expect(renewed).toBe(false);
  });

  it('should clean up all locks on module destroy', async () => {
    await lock.acquire('r1', 5000);
    await lock.acquire('r2', 5000);
    await lock.onModuleDestroy();
    expect(lock.isHeldByMe('r1')).toBe(false);
    expect(lock.isHeldByMe('r2')).toBe(false);
  });
});
