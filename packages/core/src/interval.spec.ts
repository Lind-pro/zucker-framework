import { describe, it, expect } from 'vitest';
import { Interval } from './interval';

describe('Interval.of', () => {
  it('should parse seconds', () => {
    const i = Interval.of('30s');
    expect(i.number).toBe(30);
    expect(i.unit).toBe('s');
  });

  it('should parse minutes', () => {
    const i = Interval.of('5m');
    expect(i.number).toBe(5);
    expect(i.unit).toBe('m');
  });

  it('should parse hours', () => {
    const i = Interval.of('2h');
    expect(i.number).toBe(2);
    expect(i.unit).toBe('h');
  });

  it('should parse days', () => {
    const i = Interval.of('7d');
    expect(i.number).toBe(7);
    expect(i.unit).toBe('d');
  });

  it('should parse weeks', () => {
    const i = Interval.of('1w');
    expect(i.number).toBe(1);
    expect(i.unit).toBe('w');
  });

  it('should parse milliseconds (S unit)', () => {
    const i = Interval.of('500S');
    expect(i.number).toBe(500);
    expect(i.unit).toBe('S');
  });

  it('should parse months', () => {
    const i = Interval.of('3M');
    expect(i.number).toBe(3);
    expect(i.unit).toBe('M');
  });

  it('should parse years', () => {
    const i = Interval.of('1y');
    expect(i.number).toBe(1);
    expect(i.unit).toBe('y');
  });

  it('should parse decimal numbers', () => {
    const i = Interval.of('1.5h');
    expect(i.number).toBe(1.5);
  });

  it('should parse negative numbers', () => {
    const i = Interval.of('-10m');
    expect(i.number).toBe(-10);
  });

  it('should trim whitespace', () => {
    const i = Interval.of('  30s  ');
    expect(i.number).toBe(30);
  });

  it('should throw on invalid expression', () => {
    expect(() => Interval.of('abc')).toThrow('Cannot parse interval');
    expect(() => Interval.of('')).toThrow('Cannot parse interval');
    expect(() => Interval.of('10')).toThrow('Cannot parse interval');
  });
});

describe('Interval factory methods', () => {
  it('ofSeconds creates second interval', () => {
    const i = Interval.ofSeconds(90);
    expect(i.toMilliseconds()).toBe(90_000);
  });

  it('ofMinutes creates minute interval', () => {
    const i = Interval.ofMinutes(2);
    expect(i.toMilliseconds()).toBe(120_000);
  });

  it('ofHours creates hour interval', () => {
    const i = Interval.ofHours(1);
    expect(i.toMilliseconds()).toBe(3_600_000);
  });

  it('ofDays creates day interval', () => {
    const i = Interval.ofDays(1);
    expect(i.toMilliseconds()).toBe(86_400_000);
  });
});

describe('Interval conversions', () => {
  it('toMilliseconds for each fixed unit', () => {
    expect(Interval.of('1S').toMilliseconds()).toBe(1);
    expect(Interval.of('1s').toMilliseconds()).toBe(1000);
    expect(Interval.of('1m').toMilliseconds()).toBe(60_000);
    expect(Interval.of('1h').toMilliseconds()).toBe(3_600_000);
    expect(Interval.of('1d').toMilliseconds()).toBe(86_400_000);
    expect(Interval.of('1w').toMilliseconds()).toBe(604_800_000);
  });

  it('toMilliseconds for calendar units (approximate)', () => {
    expect(Interval.of('1M').toMilliseconds()).toBe(30 * 86_400_000);
    expect(Interval.of('1y').toMilliseconds()).toBe(365 * 86_400_000);
  });

  it('toSeconds converts correctly', () => {
    expect(Interval.of('2m').toSeconds()).toBe(120);
  });

  it('toMinutes converts correctly', () => {
    expect(Interval.of('2h').toMinutes()).toBe(120);
  });

  it('should throw on unsupported unit', () => {
    const i = new Interval(1, 'x');
    expect(() => i.toMilliseconds()).toThrow('Unsupported interval unit');
  });
});

describe('Interval.iterate', () => {
  it('should iterate over a range with hourly steps', () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date('2024-01-01T03:00:00Z');
    const result = Interval.of('1h').iterate(start, end);
    expect(result).toHaveLength(4); // 0h, 1h, 2h, 3h
    expect(result[0].getTime()).toBe(start.getTime());
    expect(result[3].getTime()).toBe(end.getTime());
  });

  it('should return only start when range is zero', () => {
    const date = new Date('2024-01-01T00:00:00Z');
    const result = Interval.of('1h').iterate(date, date);
    expect(result).toHaveLength(1);
  });

  it('should return empty when end is before start', () => {
    const start = new Date('2024-01-02T00:00:00Z');
    const end = new Date('2024-01-01T00:00:00Z');
    const result = Interval.of('1h').iterate(start, end);
    expect(result).toHaveLength(0);
  });

  it('should throw on non-positive interval', () => {
    const start = new Date();
    const end = new Date(start.getTime() + 10000);
    expect(() => Interval.of('-1h').iterate(start, end)).toThrow('must be positive');
  });
});

describe('Interval.toString', () => {
  it('should return the string representation', () => {
    expect(Interval.of('30m').toString()).toBe('30m');
    expect(Interval.of('1.5h').toString()).toBe('1.5h');
  });
});
