import { describe, it, expect } from 'vitest';
import { TimerSpec } from './timer-spec';

describe('TimerSpec static factories', () => {
  it('should create cron timer', () => {
    const t = TimerSpec.cron('0 9 * * *');
    expect(t.type).toBe('cron');
    expect(t.cron).toBe('0 9 * * *');
  });

  it('should create interval timer', () => {
    const t = TimerSpec.interval(5000);
    expect(t.type).toBe('interval');
    expect(t.intervalMs).toBe(5000);
  });

  it('should create once timer', () => {
    const at = new Date('2025-06-01T12:00:00Z');
    const t = TimerSpec.once(at);
    expect(t.type).toBe('once');
    expect(t.executeAt).toBe(at);
  });

  it('should create window timer', () => {
    const t = TimerSpec.window('09:00', '17:00');
    expect(t.type).toBe('window');
    expect(t.windowStart).toBe('09:00');
    expect(t.windowEnd).toBe('17:00');
  });
});

describe('TimerSpec.nextExecutionTime - once', () => {
  it('should return executeAt when in the future', () => {
    const future = new Date(Date.now() + 100_000);
    const t = TimerSpec.once(future);
    expect(t.nextExecutionTime()).toEqual(future);
  });

  it('should return null when executeAt is in the past', () => {
    const past = new Date('2020-01-01');
    const t = TimerSpec.once(past);
    expect(t.nextExecutionTime()).toBeNull();
  });

  it('should return null when executeAt is undefined', () => {
    const t = new TimerSpec({ type: 'once' });
    expect(t.nextExecutionTime()).toBeNull();
  });
});

describe('TimerSpec.nextExecutionTime - interval', () => {
  it('should return after + intervalMs', () => {
    const t = TimerSpec.interval(5000);
    const after = new Date('2024-01-01T00:00:00Z');
    const next = t.nextExecutionTime(after);
    expect(next).toEqual(new Date('2024-01-01T00:00:05Z'));
  });

  it('should return null when intervalMs is not set', () => {
    const t = new TimerSpec({ type: 'interval' });
    expect(t.nextExecutionTime()).toBeNull();
  });
});

describe('TimerSpec.nextExecutionTime - cron', () => {
  it('should find next execution for every-minute cron', () => {
    const t = TimerSpec.cron('* * * * *');
    const after = new Date('2024-01-01T10:30:00Z');
    const next = t.nextExecutionTime(after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it('should find next execution for specific hour/minute', () => {
    const t = TimerSpec.cron('30 9 * * *');
    const after = new Date('2024-06-15T08:00:00Z');
    const next = t.nextExecutionTime(after);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(30);
    expect(next!.getHours()).toBe(9);
  });

  it('should return null for invalid cron (too few fields)', () => {
    const t = TimerSpec.cron('* *');
    expect(t.nextExecutionTime()).toBeNull();
  });
});

describe('TimerSpec.nextExecutionTime - window', () => {
  it('should return window start time for tomorrow if window passed', () => {
    const t = TimerSpec.window('09:00', '17:00');
    const after = new Date('2024-01-01T18:00:00');
    const next = t.nextExecutionTime(after);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
    expect(next!.getDate()).toBe(2); // Next day
  });

  it('should return null when windowStart is not set', () => {
    const t = new TimerSpec({ type: 'window' });
    expect(t.nextExecutionTime()).toBeNull();
  });
});

describe('TimerSpec.matches - once', () => {
  it('should match within 1 second of executeAt', () => {
    const at = new Date('2024-01-01T12:00:00Z');
    const t = TimerSpec.once(at);
    expect(t.matches(new Date('2024-01-01T12:00:00.500Z'))).toBe(true);
  });

  it('should not match when more than 1 second away', () => {
    const at = new Date('2024-01-01T12:00:00Z');
    const t = TimerSpec.once(at);
    expect(t.matches(new Date('2024-01-01T12:00:02Z'))).toBe(false);
  });

  it('should not match when executeAt is undefined', () => {
    const t = new TimerSpec({ type: 'once' });
    expect(t.matches(new Date())).toBe(false);
  });
});

describe('TimerSpec.matches - interval', () => {
  it('should always return false for interval type', () => {
    const t = TimerSpec.interval(5000);
    expect(t.matches(new Date())).toBe(false);
  });
});

describe('TimerSpec.matches - cron', () => {
  it('should match a date that fits the cron pattern', () => {
    // Every minute at 10 o'clock on any day
    const t = TimerSpec.cron('* 10 * * *');
    const date = new Date('2024-06-15T10:30:00');
    expect(t.matches(date)).toBe(true);
  });

  it('should not match a date outside the cron pattern', () => {
    const t = TimerSpec.cron('0 9 * * *');
    const date = new Date('2024-06-15T10:30:00');
    expect(t.matches(date)).toBe(false);
  });

  it('should support step expressions', () => {
    const t = TimerSpec.cron('*/15 * * * *');
    expect(t.matches(new Date('2024-01-01T00:00:00'))).toBe(true);
    expect(t.matches(new Date('2024-01-01T00:15:00'))).toBe(true);
    expect(t.matches(new Date('2024-01-01T00:07:00'))).toBe(false);
  });

  it('should support range expressions', () => {
    const t = TimerSpec.cron('0 9-11 * * *');
    expect(t.matches(new Date('2024-01-01T10:00:00'))).toBe(true);
    expect(t.matches(new Date('2024-01-01T08:00:00'))).toBe(false);
  });

  it('should support comma-separated values', () => {
    const t = TimerSpec.cron('0,30 * * * *');
    expect(t.matches(new Date('2024-01-01T05:00:00'))).toBe(true);
    expect(t.matches(new Date('2024-01-01T05:30:00'))).toBe(true);
    expect(t.matches(new Date('2024-01-01T05:15:00'))).toBe(false);
  });

  it('should return false for invalid cron', () => {
    const t = TimerSpec.cron('invalid');
    expect(t.matches(new Date())).toBe(false);
  });
});

describe('TimerSpec.matches - window', () => {
  it('should match a time inside the window', () => {
    const t = TimerSpec.window('09:00', '17:00');
    const date = new Date('2024-01-01T12:00:00');
    expect(t.matches(date)).toBe(true);
  });

  it('should not match a time outside the window', () => {
    const t = TimerSpec.window('09:00', '17:00');
    const date = new Date('2024-01-01T18:00:00');
    expect(t.matches(date)).toBe(false);
  });

  it('should match at exact window boundaries', () => {
    const t = TimerSpec.window('09:00', '17:00');
    const start = new Date('2024-01-01T09:00:00');
    const end = new Date('2024-01-01T17:00:00');
    expect(t.matches(start)).toBe(true);
    expect(t.matches(end)).toBe(true);
  });

  it('should return false when window bounds are missing', () => {
    const t = new TimerSpec({ type: 'window' });
    expect(t.matches(new Date())).toBe(false);
  });
});

describe('TimerSpec.nextExecutionTime - unknown type', () => {
  it('should return null for unknown timer type', () => {
    const t = new TimerSpec({ type: 'unknown' as any });
    expect(t.nextExecutionTime()).toBeNull();
  });
});

describe('TimerSpec.matches - unknown type', () => {
  it('should return false for unknown timer type', () => {
    const t = new TimerSpec({ type: 'unknown' as any });
    expect(t.matches(new Date())).toBe(false);
  });
});
