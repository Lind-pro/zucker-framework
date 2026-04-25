import { describe, it, expect } from 'vitest';
import { ConverterRegistry, convert } from './converter';

describe('ConverterRegistry', () => {
  it('should convert string to number', () => {
    expect(convert<number>('42', 'number')).toBe(42);
    expect(convert<number>('3.14', 'number')).toBeCloseTo(3.14);
  });

  it('should throw for invalid string to number', () => {
    expect(() => convert('abc', 'number')).toThrow('Cannot convert "abc" to number');
  });

  it('should convert number to string', () => {
    expect(convert<string>(42, 'string')).toBe('42');
  });

  it('should convert string to date', () => {
    const result = convert<Date>('2024-01-15', 'date');
    expect(result).toBeInstanceOf(Date);
    expect(result.getFullYear()).toBe(2024);
  });

  it('should throw for invalid string to date', () => {
    expect(() => convert('not-a-date', 'date')).toThrow('Cannot convert');
  });

  it('should convert date to string (ISO format)', () => {
    const d = new Date('2024-06-15T12:00:00Z');
    const result = convert<string>(d, 'string');
    expect(result).toBe(d.toISOString());
  });

  it('should convert date to number (timestamp)', () => {
    const d = new Date('2024-06-15T12:00:00Z');
    expect(convert<number>(d, 'number')).toBe(d.getTime());
  });

  it('should convert string to boolean', () => {
    expect(convert<boolean>('true', 'boolean')).toBe(true);
    expect(convert<boolean>('1', 'boolean')).toBe(true);
    expect(convert<boolean>('yes', 'boolean')).toBe(true);
    expect(convert<boolean>('false', 'boolean')).toBe(false);
    expect(convert<boolean>('0', 'boolean')).toBe(false);
    expect(convert<boolean>('no', 'boolean')).toBe(false);
  });

  it('should throw for invalid string to boolean', () => {
    expect(() => convert('maybe', 'boolean')).toThrow('Cannot convert');
  });

  it('should convert boolean to string', () => {
    expect(convert<string>(true, 'string')).toBe('true');
    expect(convert<string>(false, 'string')).toBe('false');
  });

  it('should convert boolean to number', () => {
    expect(convert<number>(true, 'number')).toBe(1);
    expect(convert<number>(false, 'number')).toBe(0);
  });

  it('should convert number to boolean', () => {
    expect(convert<boolean>(1, 'boolean')).toBe(true);
    expect(convert<boolean>(0, 'boolean')).toBe(false);
    expect(convert<boolean>(-1, 'boolean')).toBe(true);
  });

  it('should convert number to date (millisecond timestamp)', () => {
    const ts = 1718438400000; // ms
    const result = convert<Date>(ts, 'date');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(ts);
  });

  it('should convert number to date (second timestamp)', () => {
    const ts = 1718438400; // seconds
    const result = convert<Date>(ts, 'date');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(ts * 1000);
  });

  it('should convert string to array', () => {
    expect(convert<unknown[]>('a, b, c', 'array')).toEqual(['a', 'b', 'c']);
  });

  it('should convert empty string to empty array', () => {
    expect(convert<unknown[]>('  ', 'array')).toEqual([]);
  });

  it('should return null/undefined as-is', () => {
    expect(convert(null, 'string')).toBeNull();
    expect(convert(undefined, 'number')).toBeUndefined();
  });

  it('should return same type without conversion', () => {
    expect(convert<string>('hello', 'string')).toBe('hello');
    expect(convert<number>(42, 'number')).toBe(42);
  });

  it('should use any->string fallback for unknown types', () => {
    const obj = { toString: () => 'custom' };
    expect(convert<string>(obj, 'string')).toBe('custom');
  });

  it('should throw when no converter exists', () => {
    expect(() => convert([], 'boolean')).toThrow('No converter registered');
  });

  it('should support register/unregister/has', () => {
    ConverterRegistry.register('custom', 'number', { convert: () => 99 });
    expect(ConverterRegistry.has('custom', 'number')).toBe(true);
    expect(ConverterRegistry.get('custom', 'number')?.convert('anything')).toBe(99);

    ConverterRegistry.unregister('custom', 'number');
    expect(ConverterRegistry.has('custom', 'number')).toBe(false);
  });
});
