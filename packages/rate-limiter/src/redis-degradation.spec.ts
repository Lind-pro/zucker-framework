import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiterService, TooManyRequestsException } from './rate-limiter.service';

class RedisDouble extends EventEmitter {
  status = 'ready';
  defineCommand(): void {}
  connect = vi.fn(async () => { this.status = 'ready'; this.emit('ready'); });
  disconnect = vi.fn((reconnect = false) => { this.status = reconnect ? 'reconnecting' : 'end'; });
}
const neverSettles = () => new Promise<never>(() => undefined);
const limiters = { login: { points: 5, duration: 60, blockDuration: 300 } };
async function createService() {
  const client = new RedisDouble();
  const createClient = vi.fn(() => client as unknown as Redis);
  const service = new RateLimiterService({
    redis: { url: 'redis://synthetic.invalid', createClient },
    operationDeadlineMs: 750,
    circuitBreakerMs: 5000,
    limiters,
  });
  await service.onModuleInit();
  return { service, client, createClient };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('RateLimiterService Redis insurance', () => {
  it('keeps a bounded allowance during reconnect and redacts connection errors', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, client } = await createService();
    client.emit('error', Object.assign(new Error('redis://:synthetic-secret@private-host'), { code: 'ECONNRESET' }));
    expect(service.isDistributed()).toBe(false);
    for (let attempt = 0; attempt < 5; attempt++) await service.consume('login', '203.0.113.1');
    await expect(service.consume('login', '203.0.113.1')).rejects.toBeInstanceOf(TooManyRequestsException);
    expect(warn).toHaveBeenCalledWith(
      'Redis rate limiter degraded; using bounded in-process insurance limiter (event=error, code=ECONNRESET)',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-host');
    client.emit('ready');
    expect(service.isDistributed()).toBe(true);
    service.onModuleDestroy();
  });

  it('bounds hanging consumes and resets the managed connection once', async () => {
    vi.useFakeTimers();
    const primary = vi.spyOn(RateLimiterRedis.prototype, 'consume').mockImplementation(neverSettles);
    const { service, client } = await createService();
    const first = service.consume('login', '203.0.113.2');
    await vi.advanceTimersByTimeAsync(751);
    await expect(first).resolves.toMatchObject({ remaining: 4 });
    expect(client.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    for (let attempt = 0; attempt < 4; attempt++) await service.consume('login', '203.0.113.2');
    await expect(service.consume('login', '203.0.113.2')).rejects.toBeInstanceOf(TooManyRequestsException);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(service.isDistributed()).toBe(false);
    service.onModuleDestroy();
  });

  it('does not fail open when Redis reports quota exhaustion', async () => {
    const denial = { msBeforeNext: 60_000, remainingPoints: 0, consumedPoints: 6 };
    vi.spyOn(RateLimiterRedis.prototype, 'consume').mockRejectedValue(denial);
    const insurance = vi.spyOn(RateLimiterMemory.prototype, 'consume');
    const { service, client } = await createService();
    await expect(service.consume('login', '203.0.113.3')).rejects.toMatchObject({ retryAfter: 60 });
    expect(insurance).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(service.isDistributed()).toBe(true);
    service.onModuleDestroy();
  });

  it.each(['read', 'reset'] as const)('bounds administrative %s operations', async operation => {
    vi.useFakeTimers();
    vi.spyOn(RateLimiterRedis.prototype, 'get').mockImplementation(neverSettles);
    vi.spyOn(RateLimiterRedis.prototype, 'delete').mockImplementation(neverSettles);
    const { service, client } = await createService();
    const request = operation === 'read'
      ? service.getRemaining('login', 'subject') : service.reset('login', 'subject');
    await vi.advanceTimersByTimeAsync(751);
    if (operation === 'read') await expect(request).resolves.toMatchObject({ remaining: 5 });
    else await expect(request).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledExactlyOnceWith(true);
    service.onModuleDestroy();
  });

  it('clears insurance state during an administrative reset after recovery', async () => {
    vi.useFakeTimers();
    vi.spyOn(RateLimiterRedis.prototype, 'delete').mockResolvedValue(true);
    const { service, client } = await createService();
    client.emit('close');
    await service.consume('login', 'subject', 5);
    client.emit('ready');
    await service.reset('login', 'subject');
    client.emit('close');
    await expect(service.consume('login', 'subject')).resolves.toMatchObject({ remaining: 4 });
    service.onModuleDestroy();
  });

  it('owns one safe client through repeated initialization and destruction', async () => {
    const { service, client, createClient } = await createService();
    await service.onModuleInit();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith('redis://synthetic.invalid', expect.objectContaining({
      commandTimeout: 500, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
    }));
    expect(client.listenerCount('error')).toBe(1);
    service.onModuleDestroy();
    service.onModuleDestroy();
    expect(client.disconnect).toHaveBeenCalledExactlyOnceWith(false);
    expect(client.listenerCount('error')).toBe(0);
    expect(service.isDistributed()).toBe(false);
  });

  it('does not take ownership of a caller-provided Redis client', async () => {
    const client = new RedisDouble();
    const service = new RateLimiterService({ redisClient: client, limiters });
    await service.onModuleInit();
    expect(client.connect).not.toHaveBeenCalled();
    service.onModuleDestroy();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.listenerCount('error')).toBe(0);
  });

  it('retains a bounded memory limiter when initial Redis connection fails', async () => {
    vi.useFakeTimers();
    const client = new RedisDouble();
    client.connect.mockRejectedValue(new Error('connect failed'));
    const service = new RateLimiterService({
      redis: { url: 'redis://synthetic.invalid', createClient: () => client as unknown as Redis },
      limiters,
    });
    await service.onModuleInit();
    await service.consume('login', 'subject', 5);
    await expect(service.consume('login', 'subject')).rejects.toBeInstanceOf(TooManyRequestsException);
    expect(service.isDistributed()).toBe(false);
    service.onModuleDestroy();
  });

  it('retries a failed start-up connection in the background and switches to Redis', async () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const first = new RedisDouble();
    first.connect.mockRejectedValue(new Error('connect failed'));
    const second = new RedisDouble();
    const createClient = vi.fn()
      .mockReturnValueOnce(first as unknown as Redis)
      .mockReturnValueOnce(second as unknown as Redis);
    const primary = vi.spyOn(RateLimiterRedis.prototype, 'consume')
      .mockResolvedValue({ remainingPoints: 4, msBeforeNext: 1000, consumedPoints: 1 } as never);
    const service = new RateLimiterService({
      redis: { url: 'redis://synthetic.invalid', createClient, reconnectIntervalMs: 1000 },
      limiters,
    });
    await service.onModuleInit();
    expect(service.isDistributed()).toBe(false);
    expect(first.disconnect).toHaveBeenCalledWith(false);
    expect(first.listenerCount('error')).toBe(0);
    await vi.advanceTimersByTimeAsync(1001);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(service.isDistributed()).toBe(true);
    await service.consume('login', 'subject');
    expect(primary).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    expect(second.disconnect).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('stops start-up reconnect attempts on shutdown', async () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = new RedisDouble();
    client.connect.mockRejectedValue(new Error('connect failed'));
    const createClient = vi.fn(() => client as unknown as Redis);
    const service = new RateLimiterService({
      redis: { url: 'redis://synthetic.invalid', createClient, reconnectIntervalMs: 1000 },
      limiters,
    });
    await service.onModuleInit();
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
