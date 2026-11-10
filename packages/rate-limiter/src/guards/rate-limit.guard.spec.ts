import type { ExecutionContext } from '@nestjs/common';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimiterService, TooManyRequestsException } from '../rate-limiter.service';
import type { RateLimitOptions } from '../decorators/rate-limit.decorator';

function context(request: Record<string, unknown>, response: Record<string, unknown> = {}): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

async function setup(options: RateLimitOptions) {
  const service = new RateLimiterService({ limiters: { api: { points: 1, duration: 60 } } });
  await service.onModuleInit();
  const reflector = { getAllAndOverride: () => options } as unknown as Reflector;
  const consume = vi.spyOn(service, 'consume');
  return { guard: new RateLimitGuard(reflector, service), consume, service };
}

afterEach(() => vi.restoreAllMocks());

describe('RateLimitGuard', () => {
  it('keys user limits by user id and never shares the bucket with the anonymous IP fallback', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { guard, consume } = await setup({ limiter: 'api', keyExtractor: '#userId' });
    await guard.canActivate(context({ ip: '198.51.100.1', user: { id: 'u1' } }));
    await guard.canActivate(context({ ip: '198.51.100.1' }));
    expect(consume.mock.calls.map(call => call[1])).toEqual(['user:u1', 'anon-ip:198.51.100.1']);
  });

  it('rejects unauthenticated requests when requireUser is set', async () => {
    const { guard, consume } = await setup({ limiter: 'api', keyExtractor: '#userId', requireUser: true });
    await expect(guard.canActivate(context({ ip: '198.51.100.2' }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(consume).not.toHaveBeenCalled();
  });

  it('keeps the raw client IP key for IP limits and sets Retry-After on 429', async () => {
    const { guard, consume } = await setup({ limiter: 'api', message: 'slow down' });
    const setHeader = vi.fn();
    await guard.canActivate(context({ ip: '198.51.100.3' }, { setHeader }));
    await expect(guard.canActivate(context({ ip: '198.51.100.3' }, { setHeader })))
      .rejects.toBeInstanceOf(TooManyRequestsException);
    expect(consume.mock.calls[0][1]).toBe('198.51.100.3');
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));
  });

  it('does not reveal configured limiter names for an unknown limiter', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { guard } = await setup({ limiter: 'missing' });
    const error = await guard.canActivate(context({ ip: '198.51.100.4' })).catch(e => e);
    expect(String(error.message)).not.toContain('api');
  });
  it('allows the request and logs an error once when @RateLimit names a limiter that is not configured (N-L5)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { guard, consume } = await setup({ limiter: 'login' });
    await expect(guard.canActivate(context({ ip: '198.51.100.4' }))).resolves.toBe(true);
    await expect(guard.canActivate(context({ ip: '198.51.100.5' }))).resolves.toBe(true);
    await expect(guard.canActivate(context({ ip: '198.51.100.6' }))).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("'login'");
  });

  it('logs separately for each missing limiter name (N-L5)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new RateLimiterService({ limiters: { api: { points: 1, duration: 60 } } });
    await service.onModuleInit();
    let options: RateLimitOptions = { limiter: 'login' };
    const guard = new RateLimitGuard({ getAllAndOverride: () => options } as unknown as Reflector, service);
    await guard.canActivate(context({ ip: '198.51.100.7' }));
    options = { limiter: 'register' };
    await guard.canActivate(context({ ip: '198.51.100.7' }));
    await guard.canActivate(context({ ip: '198.51.100.7' }));
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('still enforces a configured limiter (N-L5)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { guard } = await setup({ limiter: 'api' });
    await guard.canActivate(context({ ip: '198.51.100.8' }));
    await expect(guard.canActivate(context({ ip: '198.51.100.8' }))).rejects.toBeInstanceOf(TooManyRequestsException);
    expect(error).not.toHaveBeenCalled();
  });
});
