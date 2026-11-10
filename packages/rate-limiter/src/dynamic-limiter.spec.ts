import { describe, expect, it } from 'vitest';
import { DynamicLimiterManager, globMatch } from './dynamic-limiter';

describe('globMatch', () => {
  it('matches * and ? like the previous regex translation', () => {
    expect(globMatch('/api/*', '/api/users/1')).toBe(true);
    expect(globMatch('/api/?', '/api/x')).toBe(true);
    expect(globMatch('/api/?', '/api/xy')).toBe(false);
    expect(globMatch('/a.b', '/aXb')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
  });

  it('runs in bounded time on pathological patterns', () => {
    const started = Date.now();
    expect(globMatch('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('is used by matchRule', () => {
    const manager = new DynamicLimiterManager();
    manager.setRule({ id: 'r', limiter: 'api', pathPattern: '/v1/*', points: 1, duration: 1, enabled: true });
    expect(manager.matchRule('/v1/x')?.id).toBe('r');
    expect(manager.matchRule('/v2/x')).toBeUndefined();
  });
});
