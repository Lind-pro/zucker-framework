import { describe, it, expect } from 'vitest';
import { diff, deepEquals } from './index';

describe('diff', () => {
  it('should detect changed fields', () => {
    const changes = diff({ name: 'Alice', age: 30 }, { name: 'Bob', age: 30 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ field: 'name', oldValue: 'Alice', newValue: 'Bob' });
  });

  it('should detect added fields', () => {
    const changes = diff({ a: 1 }, { a: 1, b: 2 });
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('b');
    expect(changes[0].oldValue).toBeUndefined();
    expect(changes[0].newValue).toBe(2);
  });

  it('should detect removed fields', () => {
    const changes = diff({ a: 1, b: 2 }, { a: 1 });
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('b');
    expect(changes[0].oldValue).toBe(2);
    expect(changes[0].newValue).toBeUndefined();
  });

  it('should return empty array for identical objects', () => {
    const changes = diff({ x: 1, y: 'z' }, { x: 1, y: 'z' });
    expect(changes).toHaveLength(0);
  });

  it('should ignore specified fields', () => {
    const changes = diff(
      { name: 'A', updatedAt: 'old', id: '1' },
      { name: 'B', updatedAt: 'new', id: '2' },
      ['updatedAt', 'id'],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('name');
  });

  it('should skip fields that are undefined on both sides', () => {
    const changes = diff({ a: undefined }, { a: undefined });
    expect(changes).toHaveLength(0);
  });

  it('should detect nested object changes', () => {
    const changes = diff(
      { config: { timeout: 30 } },
      { config: { timeout: 60 } },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('config');
  });

  it('should handle empty objects', () => {
    expect(diff({}, {})).toHaveLength(0);
  });

  it('should detect array changes', () => {
    const changes = diff({ tags: [1, 2] }, { tags: [1, 3] });
    expect(changes).toHaveLength(1);
  });

  it('should detect type changes for same-looking values', () => {
    // number 1 and string '1' - deepEquals handles cross-type
    const changes = diff({ val: 1 }, { val: '1' });
    // deepEquals considers number 1 === string '1' (cross-type comparison)
    expect(changes).toHaveLength(0);
  });
});

describe('deepEquals', () => {
  it('should return true for same reference', () => {
    const obj = { a: 1 };
    expect(deepEquals(obj, obj)).toBe(true);
  });

  it('should return true for null === null', () => {
    expect(deepEquals(null, null)).toBe(true);
  });

  it('should return false for null vs undefined', () => {
    expect(deepEquals(null, undefined)).toBe(false);
  });

  it('should compare booleans cross-type with strings', () => {
    expect(deepEquals(true, 'true')).toBe(true);
    expect(deepEquals(false, 'false')).toBe(true);
    expect(deepEquals(true, 'false')).toBe(false);
  });

  it('should compare Date objects', () => {
    const d1 = new Date('2024-01-01');
    const d2 = new Date('2024-01-01');
    const d3 = new Date('2024-01-02');
    expect(deepEquals(d1, d2)).toBe(true);
    expect(deepEquals(d1, d3)).toBe(false);
  });

  it('should compare Date vs number (timestamp)', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    expect(deepEquals(d, d.getTime())).toBe(true);
    expect(deepEquals(d.getTime(), d)).toBe(true);
  });

  it('should compare Date vs ISO string', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    expect(deepEquals(d, '2024-01-01T00:00:00.000Z')).toBe(true);
    expect(deepEquals('2024-01-01T00:00:00.000Z', d)).toBe(true);
  });

  it('should return false for Date vs invalid string', () => {
    const d = new Date('2024-01-01');
    expect(deepEquals(d, 'not-a-date')).toBe(false);
  });

  it('should compare numbers and numeric strings cross-type', () => {
    expect(deepEquals(42, '42')).toBe(true);
    expect(deepEquals('42', 42)).toBe(true);
    expect(deepEquals(42, 'abc')).toBe(false);
  });

  it('should compare arrays element-by-element', () => {
    expect(deepEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEquals([1, 2, 3], [1, 3, 2])).toBe(false);
  });

  it('should return false for array vs non-array', () => {
    expect(deepEquals([1], { 0: 1 })).toBe(false);
    expect(deepEquals({ 0: 1 }, [1])).toBe(false);
  });

  it('should compare Maps', () => {
    const m1 = new Map([['a', 1], ['b', 2]]);
    const m2 = new Map([['a', 1], ['b', 2]]);
    const m3 = new Map([['a', 1], ['b', 3]]);
    expect(deepEquals(m1, m2)).toBe(true);
    expect(deepEquals(m1, m3)).toBe(false);
  });

  it('should compare Sets', () => {
    const s1 = new Set([1, 2, 3]);
    const s2 = new Set([1, 2, 3]);
    const s3 = new Set([1, 2, 4]);
    expect(deepEquals(s1, s2)).toBe(true);
    expect(deepEquals(s1, s3)).toBe(false);
  });

  it('should compare nested objects regardless of key order', () => {
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('should return false for objects with different key counts', () => {
    expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('should handle deeply nested structures', () => {
    const a = { level1: { level2: { level3: [1, 2, { x: true }] } } };
    const b = { level1: { level2: { level3: [1, 2, { x: true }] } } };
    expect(deepEquals(a, b)).toBe(true);
  });

  it('should return false for different primitives', () => {
    expect(deepEquals('hello', 'world')).toBe(false);
    expect(deepEquals(1, 2)).toBe(false);
  });

  it('should return false for Date vs non-matching types', () => {
    expect(deepEquals(new Date(), true)).toBe(false);
    expect(deepEquals(true, new Date())).toBe(false);
  });
});
