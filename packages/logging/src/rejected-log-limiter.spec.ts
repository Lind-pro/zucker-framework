import { describe, expect, it } from 'vitest';
import { RejectedLogRateLimiter, suppressedRejectionsLog } from './rejected-log-limiter';

function create(options: ConstructorParameters<typeof RejectedLogRateLimiter>[0] = {}) {
  let now = 1_000_000;
  const limiter = new RejectedLogRateLimiter(options, () => now);
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RejectedLogRateLimiter', () => {
  it('lets a 500 and a 401 through while a 404 flood from many clients is suppressed', () => {
    const { limiter } = create({ maxPerKey: 5, maxPerStatus: 50, maxTotal: 100, maxServerErrors: 10 });
    let allowed404 = 0;
    for (let i = 0; i < 500; i += 1) {
      if (limiter.allow(404, `client-${i}`)) allowed404 += 1;
    }
    expect(allowed404).toBeLessThan(500);
    expect(allowed404).toBeLessThanOrEqual(50);
    expect(limiter.allow(500, 'other-client')).toBe(true);
    expect(limiter.allow(401, 'other-client')).toBe(true);
  });

  it('does not let 4xx traffic exhaust the 5xx budget', () => {
    const { limiter } = create({ maxPerKey: 1000, maxPerStatus: 1000, maxTotal: 10, maxServerErrors: 3 });
    for (let i = 0; i < 50; i += 1) limiter.allow(404, `c${i}`);
    expect(limiter.allow(500, 'x')).toBe(true);
  });

  it('enforces maxPerKey per status and client', () => {
    const { limiter } = create({ maxPerKey: 2 });
    expect(limiter.allow(404, 'a')).toBe(true);
    expect(limiter.allow(404, 'a')).toBe(true);
    expect(limiter.allow(404, 'a')).toBe(false);
    expect(limiter.allow(404, 'b')).toBe(true);
    expect(limiter.allow(401, 'a')).toBe(true);
  });

  it('enforces maxPerStatus across clients', () => {
    const { limiter } = create({ maxPerKey: 100, maxPerStatus: 3 });
    expect(limiter.allow(404, 'a')).toBe(true);
    expect(limiter.allow(404, 'b')).toBe(true);
    expect(limiter.allow(404, 'c')).toBe(true);
    expect(limiter.allow(404, 'd')).toBe(false);
    expect(limiter.allow(403, 'd')).toBe(true);
  });

  it('enforces maxTotal for non-5xx statuses', () => {
    const { limiter } = create({ maxPerKey: 100, maxPerStatus: 100, maxTotal: 3 });
    expect(limiter.allow(401, 'a')).toBe(true);
    expect(limiter.allow(403, 'a')).toBe(true);
    expect(limiter.allow(404, 'a')).toBe(true);
    expect(limiter.allow(429, 'a')).toBe(false);
  });

  it('enforces maxServerErrors for 5xx', () => {
    const { limiter } = create({ maxPerKey: 100, maxPerStatus: 100, maxServerErrors: 2 });
    expect(limiter.allow(500, 'a')).toBe(true);
    expect(limiter.allow(502, 'b')).toBe(true);
    expect(limiter.allow(503, 'c')).toBe(false);
    expect(limiter.allow(404, 'c')).toBe(true);
  });

  it('drains the suppressed count of a closed window exactly once', () => {
    const { limiter, advance } = create({ maxPerKey: 1, windowMs: 1000 });
    expect(limiter.allow(404, 'a')).toBe(true);
    expect(limiter.allow(404, 'a')).toBe(false);
    expect(limiter.allow(404, 'a')).toBe(false);
    // The window is still open: nothing to hand out yet.
    expect(limiter.drainSuppressed()).toBeUndefined();
    const windowStart = 1_000_000;
    advance(1000);
    expect(limiter.drainSuppressed()).toEqual({ windowStart, suppressed: 2 });
    expect(limiter.drainSuppressed()).toBeUndefined();
    // The new window starts with a fresh budget.
    expect(limiter.allow(404, 'a')).toBe(true);
  });

  it('accumulates suppressed rows of several closed windows until drained', () => {
    const { limiter, advance } = create({ maxPerKey: 1, windowMs: 1000 });
    limiter.allow(404, 'a');
    limiter.allow(404, 'a');
    advance(1000);
    limiter.allow(404, 'a');
    limiter.allow(404, 'a');
    limiter.allow(404, 'a');
    advance(1000);
    expect(limiter.drainSuppressed()).toEqual({ windowStart: 1_000_000, suppressed: 3 });
  });

  it('keeps the tracked key set bounded', () => {
    const { limiter } = create({ maxPerKey: 1, maxPerStatus: 1_000_000, maxTotal: 1_000_000 });
    let allowed = 0;
    for (let i = 0; i < 12_000; i += 1) {
      if (limiter.allow(404, `client-${i}`)) allowed += 1;
    }
    expect(allowed).toBe(10_000);
    expect(limiter.suppressedInWindow).toBe(2_000);
  });

  it('builds the summary row', () => {
    expect(suppressedRejectionsLog({ windowStart: 5, suppressed: 7 })).toEqual({
      action: 'http:suppressed',
      describe: '7 rejected requests not persisted',
      module: 'http',
      requestTime: new Date(5),
    });
  });
});
