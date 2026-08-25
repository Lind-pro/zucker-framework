import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deriveRateLimitKey,
  RateLimiterService,
  TooManyRequestsException,
} from './rate-limiter.service';

// Suppress NestJS Logger output
vi.mock('@nestjs/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/common')>();
  return {
    ...actual,
    Logger: class {
      log = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
  };
});

describe('RateLimiterService', () => {
  let service: RateLimiterService;

  beforeEach(async () => {
    service = new RateLimiterService({
      limiters: {
        login: { points: 5, duration: 60 },
        api: { points: 100, duration: 1 },
      },
    });
    await service.onModuleInit();
  });

  it('should initialize limiters from config', () => {
    expect(service.has('login')).toBe(true);
    expect(service.has('api')).toBe(true);
    expect(service.has('nonexistent')).toBe(false);
  });

  it('getLimiterNames returns all registered names', () => {
    const names = service.getLimiterNames();
    expect(names).toContain('login');
    expect(names).toContain('api');
  });

  it('isDistributed returns false for memory mode', () => {
    expect(service.isDistributed()).toBe(false);
  });

  it('consume succeeds within limits', async () => {
    const result = await service.consume('login', 'user1');
    expect(result.remaining).toBe(4);
    expect(result.consumedPoints).toBe(1);
    expect(result.msBeforeNext).toBeGreaterThanOrEqual(0);
  });

  it('consume throws TooManyRequestsException when limit exceeded', async () => {
    // Consume all 5 points
    for (let i = 0; i < 5; i++) {
      await service.consume('login', 'blocked-user');
    }
    await expect(service.consume('login', 'blocked-user')).rejects.toThrow(
      TooManyRequestsException,
    );
  });

  it('consume throws on unknown limiter', async () => {
    await expect(service.consume('unknown', 'key')).rejects.toThrow();
  });

  it('consume throws on invalid points', async () => {
    await expect(service.consume('login', 'key', 0)).rejects.toThrow();
    await expect(service.consume('login', 'key', -1)).rejects.toThrow();
    await expect(service.consume('login', 'key', NaN)).rejects.toThrow();
  });

  it('penalty consumes extra points', async () => {
    await service.consume('login', 'pen-user', 3);
    await service.penalty('login', 'pen-user', 2);
    // After 3 consumed + 2 penalty = 5, next should be rejected
    await expect(service.consume('login', 'pen-user')).rejects.toThrow(TooManyRequestsException);
  });

  it('reward reduces consumed points', async () => {
    await service.consume('login', 'rew-user', 4);
    await service.reward('login', 'rew-user', 2);
    // After 4 consumed - 2 reward = 2, should be able to consume 3 more
    const result = await service.consume('login', 'rew-user');
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it('reset clears consumed points for a key', async () => {
    await service.consume('login', 'reset-user', 5);
    await service.reset('login', 'reset-user');
    const result = await service.consume('login', 'reset-user');
    expect(result.remaining).toBe(4);
  });

  it('getRemaining returns full quota for fresh key', async () => {
    const info = await service.getRemaining('login', 'fresh-key');
    expect(info.remaining).toBe(5);
    expect(info.resetAt).toBeInstanceOf(Date);
  });

  it('getRemaining returns reduced quota after consumption', async () => {
    await service.consume('login', 'used-key', 2);
    const info = await service.getRemaining('login', 'used-key');
    expect(info.remaining).toBe(3);
  });

  it('skips invalid limiter configs (points <= 0)', async () => {
    const svc = new RateLimiterService({
      limiters: {
        bad: { points: 0, duration: 10 },
        good: { points: 5, duration: 10 },
      },
    });
    await svc.onModuleInit();
    expect(svc.has('bad')).toBe(false);
    expect(svc.has('good')).toBe(true);
  });

  it('onModuleDestroy clears limiters', () => {
    service.onModuleDestroy();
    expect(service.getLimiterNames()).toHaveLength(0);
  });

  it('TooManyRequestsException has retryAfter property', async () => {
    for (let i = 0; i < 5; i++) {
      await service.consume('login', 'retry-user');
    }
    try {
      await service.consume('login', 'retry-user');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TooManyRequestsException);
      expect((e as TooManyRequestsException).retryAfter).toBeGreaterThan(0);
    }
  });

  it('derives stable non-reversible storage keys when a secret is configured', () => {
    const first = deriveRateLimitKey('203.0.113.9', 'test-only-secret-with-at-least-32-characters');
    const repeated = deriveRateLimitKey(
      '203.0.113.9',
      'test-only-secret-with-at-least-32-characters',
    );

    expect(first).toBe(repeated);
    expect(first).toMatch(/^v1:[a-f0-9]{64}$/u);
    expect(first).not.toContain('203.0.113.9');
    expect(deriveRateLimitKey('203.0.113.9')).toBe('203.0.113.9');
  });
});
