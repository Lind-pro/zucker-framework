import { describe, it, expect } from 'vitest';
import {
  copyProperties,
  copyNonNullProperties,
  merge,
  deepCopy,
  toPlainObject,
  fromPlainObject,
  pick,
  omit,
} from './bean-copier';

describe('copyProperties', () => {
  it('should copy all properties from source to target', () => {
    const source = { a: 1, b: 'hello' };
    const target = { c: true } as Record<string, unknown>;
    const result = copyProperties(source, target);
    expect(result).toBe(target);
    expect(result).toEqual({ a: 1, b: 'hello', c: true });
  });

  it('should ignore specified fields', () => {
    const source = { a: 1, b: 2, c: 3 };
    const target = {} as Record<string, unknown>;
    copyProperties(source, target, 'b', 'c');
    expect(target).toEqual({ a: 1 });
  });

  it('should return target unchanged when source is null', () => {
    const target = { x: 1 };
    const result = copyProperties(null as any, target);
    expect(result).toBe(target);
    expect(result).toEqual({ x: 1 });
  });

  it('should return target unchanged when source is undefined', () => {
    const target = { x: 1 };
    const result = copyProperties(undefined as any, target);
    expect(result).toBe(target);
  });

  it('should overwrite existing properties including null values', () => {
    const source = { a: null, b: 2 };
    const target = { a: 'old', b: 'old' } as Record<string, unknown>;
    copyProperties(source, target);
    expect(target).toEqual({ a: null, b: 2 });
  });

  it('should handle empty source object', () => {
    const target = { a: 1 };
    copyProperties({}, target);
    expect(target).toEqual({ a: 1 });
  });
});

describe('copyNonNullProperties', () => {
  it('should copy non-null properties', () => {
    const source = { a: 1, b: 'hello' };
    const target = {} as Record<string, unknown>;
    copyNonNullProperties(source, target);
    expect(target).toEqual({ a: 1, b: 'hello' });
  });

  it('should skip null values', () => {
    const source = { a: 1, b: null };
    const target = { b: 'keep' } as Record<string, unknown>;
    copyNonNullProperties(source, target);
    expect(target).toEqual({ a: 1, b: 'keep' });
  });

  it('should skip undefined values', () => {
    const source = { a: 1, b: undefined };
    const target = { b: 'keep' } as Record<string, unknown>;
    copyNonNullProperties(source, target);
    expect(target).toEqual({ a: 1, b: 'keep' });
  });

  it('should respect ignore fields', () => {
    const source = { a: 1, b: 2, c: 3 };
    const target = {} as Record<string, unknown>;
    copyNonNullProperties(source, target, 'a');
    expect(target).toEqual({ b: 2, c: 3 });
  });

  it('should return target when source is null', () => {
    const target = { x: 1 };
    const result = copyNonNullProperties(null as any, target);
    expect(result).toBe(target);
  });
});

describe('merge', () => {
  it('should deep merge nested objects', () => {
    const source = { nested: { a: 1 } };
    const target = { nested: { b: 2 } } as any;
    merge(source, target);
    expect(target.nested).toEqual({ a: 1, b: 2 });
  });

  it('should skip null and undefined source values', () => {
    const source = { a: null, b: undefined, c: 3 };
    const target = { a: 'keep', b: 'keep', c: 0 } as any;
    merge(source, target);
    expect(target).toEqual({ a: 'keep', b: 'keep', c: 3 });
  });

  it('should replace arrays by default', () => {
    const source = { arr: [3, 4] };
    const target = { arr: [1, 2] } as any;
    merge(source, target);
    expect(target.arr).toEqual([3, 4]);
  });

  it('should concat arrays when arrayMerge is concat', () => {
    const source = { arr: [3, 4] };
    const target = { arr: [1, 2] } as any;
    merge(source, target, { arrayMerge: 'concat' });
    expect(target.arr).toEqual([1, 2, 3, 4]);
  });

  it('should union arrays when arrayMerge is union', () => {
    const source = { arr: [2, 3, 4] };
    const target = { arr: [1, 2, 3] } as any;
    merge(source, target, { arrayMerge: 'union' });
    expect(target.arr).toEqual([1, 2, 3, 4]);
  });

  it('should not deep merge Date objects', () => {
    const srcDate = new Date('2024-01-01');
    const source = { d: srcDate };
    const target = { d: new Date('2020-01-01') } as any;
    merge(source, target);
    expect(target.d).toBe(srcDate);
  });

  it('should handle deeply nested merge', () => {
    const source = { a: { b: { c: 'new' } } };
    const target = { a: { b: { c: 'old', d: 'keep' } } } as any;
    merge(source, target);
    expect(target.a.b).toEqual({ c: 'new', d: 'keep' });
  });
});

describe('deepCopy', () => {
  it('should return null for null input', () => {
    expect(deepCopy(null)).toBeNull();
  });

  it('should return undefined for undefined input', () => {
    expect(deepCopy(undefined)).toBeUndefined();
  });

  it('should return primitives as-is', () => {
    expect(deepCopy(42)).toBe(42);
    expect(deepCopy('hello')).toBe('hello');
    expect(deepCopy(true)).toBe(true);
  });

  it('should deep copy Date', () => {
    const date = new Date('2024-06-15');
    const copy = deepCopy(date);
    expect(copy).toEqual(date);
    expect(copy).not.toBe(date);
    expect(copy instanceof Date).toBe(true);
  });

  it('should deep copy arrays', () => {
    const arr = [1, { a: 2 }, [3]];
    const copy = deepCopy(arr);
    expect(copy).toEqual(arr);
    expect(copy).not.toBe(arr);
    expect(copy[1]).not.toBe(arr[1]);
  });

  it('should deep copy Map', () => {
    const map = new Map([['key', { nested: true }]]);
    const copy = deepCopy(map);
    expect(copy).toEqual(map);
    expect(copy).not.toBe(map);
    expect(copy.get('key')).not.toBe(map.get('key'));
  });

  it('should deep copy Set', () => {
    const set = new Set([1, 2, 3]);
    const copy = deepCopy(set);
    expect(copy).toEqual(set);
    expect(copy).not.toBe(set);
  });

  it('should deep copy nested objects', () => {
    const obj = { a: { b: { c: 1 } } };
    const copy = deepCopy(obj);
    expect(copy).toEqual(obj);
    expect(copy.a).not.toBe(obj.a);
    expect(copy.a.b).not.toBe(obj.a.b);
  });

  it('should handle empty array', () => {
    expect(deepCopy([])).toEqual([]);
  });

  it('should handle empty object', () => {
    expect(deepCopy({})).toEqual({});
  });
});

describe('toPlainObject', () => {
  it('should flatten nested objects', () => {
    const obj = { a: { b: 1, c: 2 } };
    const result = toPlainObject(obj);
    expect(result).toEqual({ 'a.b': 1, 'a.c': 2 });
  });

  it('should handle null and undefined values', () => {
    const obj = { a: null, b: undefined };
    const result = toPlainObject(obj);
    expect(result).toEqual({ a: null, b: undefined });
  });

  it('should use prefix', () => {
    const obj = { x: 1 };
    const result = toPlainObject(obj, 'root');
    expect(result).toEqual({ 'root.x': 1 });
  });

  it('should respect maxDepth', () => {
    const obj = { a: { b: { c: { d: 1 } } } };
    const result = toPlainObject(obj, '', { maxDepth: 1 });
    // at depth 1, a.b should not be expanded further
    expect(result).not.toHaveProperty('a.b.c.d');
  });

  it('should expand arrays when expandArrays is true', () => {
    const obj = { items: [10, 20] };
    const result = toPlainObject(obj, '', { expandArrays: true });
    expect(result).toEqual({ 'items[0]': 10, 'items[1]': 20 });
  });

  it('should not expand arrays by default', () => {
    const obj = { items: [10, 20] };
    const result = toPlainObject(obj);
    expect(result).toEqual({ items: [10, 20] });
  });

  it('should not expand Date objects', () => {
    const d = new Date('2024-01-01');
    const obj = { created: d };
    const result = toPlainObject(obj);
    expect(result).toEqual({ created: d });
  });

  it('should handle empty object', () => {
    expect(toPlainObject({})).toEqual({});
  });
});

describe('fromPlainObject', () => {
  it('should restore nested structure from flat paths', () => {
    const flat = { 'a.b': 1, 'a.c': 2, 'd': 3 };
    const result = fromPlainObject(flat);
    expect(result).toEqual({ a: { b: 1, c: 2 }, d: 3 });
  });

  it('should handle single-level keys', () => {
    const flat = { a: 1, b: 2 };
    const result = fromPlainObject(flat);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should handle deeply nested paths', () => {
    const flat = { 'a.b.c.d': 'deep' };
    const result = fromPlainObject(flat);
    expect(result).toEqual({ a: { b: { c: { d: 'deep' } } } });
  });

  it('should handle empty input', () => {
    expect(fromPlainObject({})).toEqual({});
  });
});

describe('pick', () => {
  it('should pick specified fields', () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(pick(obj, 'a', 'c')).toEqual({ a: 1, c: 3 });
  });

  it('should ignore fields not in source', () => {
    const obj = { a: 1 } as any;
    expect(pick(obj, 'a', 'z')).toEqual({ a: 1 });
  });

  it('should return empty object when no fields match', () => {
    const obj = { a: 1 };
    expect(pick(obj)).toEqual({});
  });
});

describe('omit', () => {
  it('should omit specified fields', () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(omit(obj, 'b')).toEqual({ a: 1, c: 3 });
  });

  it('should return all fields when no omissions specified', () => {
    const obj = { a: 1, b: 2 };
    expect(omit(obj)).toEqual({ a: 1, b: 2 });
  });

  it('should handle omitting all fields', () => {
    const obj = { a: 1, b: 2 };
    expect(omit(obj, 'a', 'b')).toEqual({});
  });
});
