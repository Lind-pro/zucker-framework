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

describe('parseCron DST and day-field semantics (M4)', () => {
  const seq = (cron: string, tz: string, from: string, n: number): string[] => {
    const schedule = parseCron(cron, tz);
    const out: string[] = [];
    let d = new Date(from);
    for (let i = 0; i < n; i++) {
      const nx = schedule.next(d);
      if (!nx) break;
      out.push(nx.toISOString());
      d = nx;
    }
    return out;
  };

  it('fixed time inside a repeated hour fires once (New York fall-back)', () => {
    expect(seq('30 1 * * *', 'America/New_York', '2026-10-31T12:00:00Z', 2)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
  });

  it('a time skipped by a spring-forward gap fires once right after the jump (New York)', () => {
    expect(next('30 2 * * *', '2026-03-07T12:00:00Z', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z');
  });

  it('midnight skipped by a gap fires after the jump (Havana)', () => {
    expect(next('0 0 * * *', '2026-03-07T12:00:00Z', 'America/Havana')).toBe('2026-03-08T05:00:00.000Z');
  });

  it('Lord Howe half-hour DST gap fires at the first instant after the gap', () => {
    expect(next('15 2 * * *', '2026-10-03T00:00:00Z', 'Australia/Lord_Howe')).toBe('2026-10-03T15:30:00.000Z');
  });

  it('*/15 across both New York transitions has no skipped or duplicated real-time runs', () => {
    for (const [from, to] of [
      ['2026-03-08T04:00:00Z', '2026-03-08T12:00:00Z'],
      ['2026-11-01T03:00:00Z', '2026-11-01T11:00:00Z'],
    ]) {
      const schedule = parseCron('*/15 * * * *', 'America/New_York');
      const times: number[] = [];
      let d = new Date(from);
      for (;;) {
        const nx = schedule.next(d);
        if (!nx || nx.getTime() > new Date(to).getTime()) break;
        times.push(nx.getTime());
        d = nx;
      }
      const unique = new Set(times);
      expect(unique.size).toBe(times.length); // no duplicates
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBe(15 * 60_000); // none skipped
    }
  });

  it('a day field starting with * is unrestricted: "0 0 */2 * 1" fires on Mondays only', () => {
    const dates = seq('0 0 */2 * 1', 'UTC', '2026-11-01T00:00:00Z', 5);
    expect(dates).toHaveLength(5);
    for (const iso of dates) expect(new Date(iso).getUTCDay()).toBe(1);
    expect(dates[0]).toBe('2026-11-02T00:00:00.000Z');
  });

  it('"0 0 13 * 5" keeps OR semantics (13th or Friday)', () => {
    expect(seq('0 0 13 * 5', 'UTC', '2026-11-01T00:00:00Z', 4)).toEqual([
      '2026-11-06T00:00:00.000Z',
      '2026-11-13T00:00:00.000Z',
      '2026-11-20T00:00:00.000Z',
      '2026-11-27T00:00:00.000Z',
    ]);
  });

  it('"0 0 ? * ?" equals "0 0 * * *"', () => {
    expect(seq('0 0 ? * ?', 'UTC', '2026-11-10T12:00:00Z', 3)).toEqual(seq('0 0 * * *', 'UTC', '2026-11-10T12:00:00Z', 3));
  });

  it('a zone without DST is unchanged (Asia/Shanghai)', () => {
    expect(seq('0 0 2 * * *', 'Asia/Shanghai', '2026-11-10T00:00:00Z', 2)).toEqual([
      '2026-11-10T18:00:00.000Z',
      '2026-11-11T18:00:00.000Z',
    ]);
  });
});

