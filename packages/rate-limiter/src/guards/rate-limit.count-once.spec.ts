import { UseGuards, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { RateLimiterService, TooManyRequestsException } from '../rate-limiter.service';
import { GlobalRateLimitGuard, RateLimitGuard } from './rate-limit.guard';

class ListedController {
  @RateLimit({ limiter: 'api' })
  @UseGuards(RateLimitGuard)
  handler(): void {}
}

class UnlistedController {
  @RateLimit({ limiter: 'api' })
  handler(): void {}
}

@UseGuards(RateLimitGuard)
class ClassListedController {
  @RateLimit({ limiter: 'api' })
  @UseGuards(RateLimitGuard)
  handler(): void {}
}

function context(target: { prototype: { handler: () => void } }, request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => target.prototype.handler,
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: () => undefined }) }),
  } as unknown as ExecutionContext;
}

async function setup(points: number) {
  const service = new RateLimiterService({ limiters: { api: { points, duration: 60 } } });
  await service.onModuleInit();
  const reflector = new Reflector();
  return { global: new GlobalRateLimitGuard(reflector, service), route: new RateLimitGuard(reflector, service) };
}

/** Runs one request through the guard chain Nest would build; returns true when admitted. */
async function request(guards: RateLimitGuard[], target: { prototype: { handler: () => void } }): Promise<boolean> {
  const req = { ip: '203.0.113.9' };
  try {
    for (const guard of guards) await guard.canActivate(context(target, req));
    return true;
  } catch (error) {
    if (error instanceof TooManyRequestsException) return false;
    throw error;
  }
}

async function admitted(guards: RateLimitGuard[], target: { prototype: { handler: () => void } }, attempts: number) {
  let count = 0;
  for (let i = 0; i < attempts; i += 1) if (await request(guards, target)) count += 1;
  return count;
}

describe('RateLimitGuard counts a request once', () => {
  it('global guard + @UseGuards(RateLimitGuard) admits exactly N of a limit of N', async () => {
    const { global, route } = await setup(5);
    expect(await admitted([global, route], ListedController, 8)).toBe(5);
  });

  it('guard listed on the class and the handler admits exactly N', async () => {
    const { route } = await setup(3);
    expect(await admitted([route, route], ClassListedController, 6)).toBe(3);
  });

  it('global guard alone still limits routes that do not list the guard', async () => {
    const { global } = await setup(4);
    expect(await admitted([global], UnlistedController, 7)).toBe(4);
  });

  it('global guard defers to the route copy (which runs after authentication)', async () => {
    const service = new RateLimiterService({ limiters: { api: { points: 10, duration: 60 } } });
    await service.onModuleInit();
    const consumed: string[] = [];
    const spy = { has: (name: string) => service.has(name), consume: (name: string, key: string) => { consumed.push(key); return service.consume(name, key); } };
    const reflector = new Reflector();
    const req: Record<string, unknown> = { ip: '203.0.113.10' };
    await new GlobalRateLimitGuard(reflector, spy).canActivate(context(ListedController, req));
    expect(consumed).toEqual([]);
    await new RateLimitGuard(reflector, spy).canActivate(context(ListedController, req));
    expect(consumed).toEqual(['203.0.113.10']);
    expect(Object.keys(req)).toEqual(['ip']);
  });
});
