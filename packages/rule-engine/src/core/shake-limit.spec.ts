import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createShakeLimit } from './shake-limit';

describe('createShakeLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should always allow when disabled', () => {
    const limiter = createShakeLimit({ enabled: false, time: 1000, threshold: 1 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('should allow up to threshold within the time window', () => {
    const limiter = createShakeLimit({ enabled: true, time: 1000, threshold: 3 });
    expect(limiter.tryAcquire()).toBe(true); // 1
    expect(limiter.tryAcquire()).toBe(true); // 2
    expect(limiter.tryAcquire()).toBe(true); // 3
    expect(limiter.tryAcquire()).toBe(false); // 4 — over threshold
  });

  it('should reset the window after time expires', () => {
    const limiter = createShakeLimit({ enabled: true, time: 1000, threshold: 1 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(limiter.tryAcquire()).toBe(true);
  });

  it('should support manual reset', () => {
    const limiter = createShakeLimit({ enabled: true, time: 60000, threshold: 1 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    limiter.reset();
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('should treat threshold=0 as threshold=1 (safeThreshold)', () => {
    const limiter = createShakeLimit({ enabled: true, time: 1000, threshold: 0 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('should treat time=0 as time=1 (safeTime)', () => {
    const limiter = createShakeLimit({ enabled: true, time: 0, threshold: 1 });
    expect(limiter.tryAcquire()).toBe(true);
    // After 1ms window resets
    vi.advanceTimersByTime(2);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('should handle multiple windows correctly', () => {
    const limiter = createShakeLimit({ enabled: true, time: 100, threshold: 2 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    vi.advanceTimersByTime(101);

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('should count from 1 after window reset (first acquire starts new window)', () => {
    const limiter = createShakeLimit({ enabled: true, time: 100, threshold: 1 });
    expect(limiter.tryAcquire()).toBe(true);
    vi.advanceTimersByTime(101);
    // New window — first acquire should pass and count = 1
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });
});
