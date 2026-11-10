import { describe, it, expect } from 'vitest';
import { parseCron } from './cron';

const next = (cron: string, from: string, tz = 'UTC') =>
  parseCron(cron, tz).next(new Date(from))?.toISOString();

describe('parseCron', () => {
  it('5-field minute/hour/dow schedule (Mondays 09:00)', () => {
    // 2026-03-10 is a Tuesday
    expect(next('0 9 * * 1', '2026-03-10T10:00:00Z')).toBe('2026-03-16T09:00:00.000Z');
  });

  it('6-field schedule with seconds (daily 02:00:00)', () => {
    expect(next('0 0 2 * * *', '2026-03-10T10:00:00Z')).toBe('2026-03-11T02:00:00.000Z');
  });

  it('steps, ranges, lists and names', () => {
    expect(next('*/15 * * * *', '2026-03-10T10:07:00Z')).toBe('2026-03-10T10:15:00.000Z');
    expect(next('0 8-10/2 * * MON-FRI', '2026-03-14T00:00:00Z')).toBe('2026-03-16T08:00:00.000Z');
    expect(next('0 0 1 JAN,JUL *', '2026-03-10T00:00:00Z')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('day-of-month OR day-of-week when both are restricted', () => {
    // 15th or Sunday; 2026-03-15 is a Sunday anyway, check from 03-16 → next is 03-22 (Sun)
    expect(next('0 0 15 * 0', '2026-03-16T00:00:00Z')).toBe('2026-03-22T00:00:00.000Z');
  });

  it('honours timezone', () => {
    expect(next('0 9 * * *', '2026-03-10T00:00:00Z', 'Asia/Shanghai')).toBe('2026-03-10T01:00:00.000Z');
  });

  it('handles Feb 29 and impossible dates', () => {
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
    expect(parseCron('0 0 31 2 *').next(new Date('2026-01-01T00:00:00Z'))).toBeUndefined();
  });

  it('rejects invalid fields', () => {
    expect(() => parseCron('61 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('* * * *')).toThrow(/5-7 fields/);
    expect(() => parseCron('0 0 ? * 1#2')).toThrow();
  });
});
