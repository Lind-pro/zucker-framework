import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  describe('ownership (regression: H1)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('a stale withLock finally does not delete a lock taken over by another caller in the same process', async () => {
      const slow = lock.withLock('shared', 20, async () => {
        await sleep(50);
        return 'slow';
      }, { watchdog: false });
      await sleep(30); // first lock has expired
      const tokenB = await lock.acquireToken('shared', 5000);
      expect(tokenB).not.toBeNull();
      await expect(slow).resolves.toBe('slow');
      expect(redis.store.get('zucker:lock:shared')?.value).toBe(tokenB);
      expect(lock.isHeldByMe('shared')).toBe(true);
    });

    it('renew does not overwrite a lock now held by another node', async () => {
      await lock.acquire('r', 10);
      await sleep(20);
      const lock2 = new RedisDistributedLock();
      lock2.configure(redis);
      expect(await lock2.acquire('r', 5000)).toBe(true);
      const otherValue = redis.store.get('zucker:lock:r')?.value;

      expect(await lock.renew('r', 5000)).toBe(false);
      expect(redis.store.get('zucker:lock:r')?.value).toBe(otherValue);
      expect(lock.isHeldByMe('r')).toBe(false);
    });

    it('release clears local state even when the lock already expired', async () => {
      await lock.acquire('r', 10);
      await sleep(20);
      await lock.release('r');
      expect(lock.isHeldByMe('r')).toBe(false);
    });

    it('release of an expired lock does not delete the new holder', async () => {
      await lock.acquire('r', 10);
      await sleep(20);
      const lock2 = new RedisDistributedLock();
      lock2.configure(redis);
      await lock2.acquire('r', 5000);
      await lock.release('r');
      expect(await lock2.isLocked('r')).toBe(true);
      expect(lock2.isHeldByMe('r')).toBe(true);
    });

    it('withLock watchdog keeps the lock while fn outlives ttl', async () => {
      const lock2 = new RedisDistributedLock();
      lock2.configure(redis);
      let competitor: boolean | undefined;
      await lock.withLock('r', 40, async () => {
        await sleep(100);
        competitor = await lock2.acquire('r', 1000);
      });
      expect(competitor).toBe(false);
      expect(await lock.isLocked('r')).toBe(false);
    });

    it('withLock aborts the signal when the lock is lost', async () => {
      let aborted = false;
      await lock.withLock('r', 60, async (signal) => {
        redis.store.delete('zucker:lock:r');
        await sleep(60);
        aborted = signal.aborted;
      }, { renewIntervalMs: 10 });
      expect(aborted).toBe(true);
    });
  });

  describe('watchdog and expiry with a monotonic clock (M3, L1)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Resolves with the elapsed fake-ms at which `signal` aborted (or undefined if never within `maxMs`). */
    const abortTime = async (signal: AbortSignal, maxMs: number): Promise<number | undefined> => {
      const t0 = performance.now();
      let at: number | undefined;
      signal.addEventListener('abort', () => {
        at = performance.now() - t0;
      });
      await vi.advanceTimersByTimeAsync(maxMs);
      return at;
    };

    it('eval rejecting on every renewal aborts no later than the TTL after acquisition', async () => {
      const failing = createMockRedis();
      failing.eval = vi.fn().mockRejectedValue(new Error('redis down')) as never;
      lock.configure(failing);
      let at: number | undefined;
      const run = lock.withLock(
        'r',
        300,
        async (signal) => {
          at = await abortTime(signal, 1000);
        },
        { renewIntervalMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await run;
      expect(at).toBeDefined();
      expect(at!).toBeLessThanOrEqual(300);
    });

    it('one renewal failure followed by success does not abort', async () => {
      const flaky = createMockRedis();
      const realEval = flaky.eval!.bind(flaky);
      let calls = 0;
      flaky.eval = (async (...args: unknown[]) => {
        if (++calls === 1) throw new Error('blip');
        return (realEval as (...a: unknown[]) => unknown)(...args);
      }) as never;
      lock.configure(flaky);
      let aborted: boolean | undefined;
      const run = lock.withLock(
        'r',
        300,
        async (signal) => {
          await vi.advanceTimersByTimeAsync(1500);
          aborted = signal.aborted;
        },
        { renewIntervalMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(2000);
      await run;
      expect(calls).toBeGreaterThan(1);
      expect(aborted).toBe(false);
    });

    it('a renewal returning 0 aborts', async () => {
      let at: number | undefined;
      const run = lock.withLock(
        'r',
        300,
        async (signal) => {
          redis.store.delete('zucker:lock:r'); // lock lost: the compare-and-renew script returns 0
          at = await abortTime(signal, 500);
        },
        { renewIntervalMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(600);
      await run;
      expect(at).toBeDefined();
      expect(at!).toBeLessThanOrEqual(100);
    });

    it('watchdog: false creates no timers', async () => {
      let timers = -1;
      const run = lock.withLock(
        'r',
        300,
        async () => {
          timers = vi.getTimerCount();
        },
        { watchdog: false },
      );
      await vi.advanceTimersByTimeAsync(0);
      await run;
      expect(timers).toBe(0);
    });

    it('isHeldByMe is false after the TTL', async () => {
      await lock.acquire('r', 1000);
      expect(lock.isHeldByMe('r')).toBe(true);
      await vi.advanceTimersByTimeAsync(999);
      expect(lock.isHeldByMe('r')).toBe(true);
      await vi.advanceTimersByTimeAsync(2);
      expect(lock.isHeldByMe('r')).toBe(false);
    });
  });
});
