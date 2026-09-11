import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { CacheService } from './cache.service';
import { RedisCacheService } from './redis-cache.service';

class RedisDouble extends EventEmitter {
  connect = vi.fn(async () => { this.emit('ready'); });
  disconnect = vi.fn((_reconnect = false) => undefined);
  get = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
  set = vi.fn<() => Promise<string>>().mockResolvedValue('OK');
  del = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  exists = vi.fn<() => Promise<number>>().mockResolvedValue(0);
  incr = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  expire = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  ttl = vi.fn<() => Promise<number>>().mockResolvedValue(60);
}

const neverSettles = () => new Promise<never>(() => undefined);
async function createService(client = new RedisDouble()) {
  const factory = vi.fn(() => client as unknown as Redis);
  const service = new RedisCacheService({ url: 'redis://synthetic.invalid', createClient: factory });
  await service.onModuleInit();
  return { service, client, factory };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('RedisCacheService bounded degradation', () => {
  it('bounds a hanging read, resets once, and allows authoritative loading', async () => {
    vi.useFakeTimers();
    const { service, client } = await createService();
    client.get.mockImplementation(neverSettles);
    const cache = new CacheService(service);
    const first = cache.getOrSet('item', async () => 'database-result', 60);
    await vi.advanceTimersByTimeAsync(751);
    await expect(first).resolves.toBe('database-result');
    expect(client.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    expect(service.isAvailable()).toBe(false);
    await expect(service.get('another')).resolves.toBeNull();
    expect(client.get).toHaveBeenCalledTimes(1);
    client.get.mockResolvedValue('"recovered"');
    client.emit('ready');
    expect(service.isAvailable()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(service.get('item')).resolves.toBe('recovered');
    expect(service.isAvailable()).toBe(true);
    await cache.onModuleDestroy();
    service.onModuleDestroy();
  });

  it('never queues or replays commands and initializes or destroys only once', async () => {
    const { service, client, factory } = await createService();
    await service.onModuleInit();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('redis://synthetic.invalid', expect.objectContaining({
      commandTimeout: 500, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
    }));
    service.onModuleDestroy();
    service.onModuleDestroy();
    expect(client.disconnect).toHaveBeenCalledExactlyOnceWith(false);
    expect(service.isAvailable()).toBe(false);
  });

  it('uses JSON and seconds TTL without manufacturing immortal keys', async () => {
    const { service, client } = await createService();
    await service.set('item', { count: 1 }, 60);
    expect(client.set).toHaveBeenCalledWith('item', '{"count":1}', 'PX', 60000);
    await service.set('zero', 'invalid', 0);
    await service.set('fraction', 'invalid', 0.5);
    expect(client.set).toHaveBeenCalledTimes(1);
    client.get.mockResolvedValue('{"count":1}');
    await expect(service.get('item')).resolves.toEqual({ count: 1 });
    await expect(service.incr('count', 60)).resolves.toBe(1);
    expect(client.expire).toHaveBeenCalledWith('count', 60);
    service.onModuleDestroy();
  });

  it('redacts connection errors and treats malformed JSON as a bounded cache miss', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, client } = await createService();
    client.get.mockResolvedValue('malformed JSON');
    await expect(service.get('item')).resolves.toBeNull();
    client.emit('error', Object.assign(new Error('redis://:synthetic-secret@private-host'), { code: 'ECONNRESET' }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-host');
    service.onModuleDestroy();
  });
});
