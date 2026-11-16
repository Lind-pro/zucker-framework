// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RedisCache, type RedisClient } from './redis-cache';

// Explicit disposable endpoint only. Never clear a shared database; clean this test's own keys.
const redisUrl = process.env.TEST_REDIS_URL;
describe.skipIf(!redisUrl)('Redis sequence contract', () => {
  it('atomically advances across clients, preserves TTL and rejects corrupt/overflowing state', async () => {
    const { default: Redis } = await import('ioredis');
    const one = new Redis(redisUrl!, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    const two = new Redis(redisUrl!, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    const prefix = `zucker-sequence-test:${randomUUID()}:`;
    const a = new RedisCache(one as unknown as RedisClient, { prefix });
    const b = new RedisCache(two as unknown as RedisClient, { prefix });
    try {
      await Promise.all([one.connect(), two.connect()]);
      const values = await Promise.all(Array.from({ length: 100 }, (_, i) =>
        (i % 2 ? a : b).advanceSequence('k', 1_800_000_000_000, 60_000)));
      expect([...values].sort((x, y) => x - y)).toEqual(Array.from({ length: 100 }, (_, i) => 1_800_000_000_000 + i));
      expect(await b.readSequence('k')).toBe(1_800_000_000_099);
      const nearLimit = Number.MAX_SAFE_INTEGER - 7;
      const highValues = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? a : b).advanceSequence('high', nearLimit, 60_000)));
      expect(highValues.sort((x, y) => x - y)).toEqual(Array.from({ length: 8 }, (_, i) => nearLimit + i));
      expect(await b.readSequence('high')).toBe(Number.MAX_SAFE_INTEGER);
      await expect(a.advanceSequence('high', 0, 1000)).rejects.toThrow(/overflow/);
      expect(await one.get(`${prefix}high`)).toBe(String(Number.MAX_SAFE_INTEGER));
      await a.advanceSequence('k', 0, 1000);
      expect(await one.pttl(`${prefix}k`)).toBeGreaterThan(50_000);
      await one.set(`${prefix}k`, '"invalid"', 'PX', 60_000);
      await expect(a.advanceSequence('k', 0, 1000)).rejects.toThrow(/Invalid cache sequence/);
      expect(await one.get(`${prefix}k`)).toBe('"invalid"');
      await one.set(`${prefix}k`, String(Number.MAX_SAFE_INTEGER - 1));
      expect(await a.advanceSequence('k', 0, 1000)).toBe(Number.MAX_SAFE_INTEGER);
      expect(await b.readSequence('k')).toBe(Number.MAX_SAFE_INTEGER);
      await expect(b.advanceSequence('k', 0, 1000)).rejects.toThrow(/overflow/);
    } finally {
      if (one.status === 'ready') await one.del(`${prefix}k`, `${prefix}high`);
      one.disconnect();
      two.disconnect();
    }
  });
});
