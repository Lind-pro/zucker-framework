import { describe, it, expect } from 'vitest';
import { convertValue } from './data-type';
import type {
  IntDataType,
  FloatDataType,
  BooleanDataType,
  EnumDataType,
  DateDataType,
} from './data-type';

describe('convertValue', () => {
  it('passes null/undefined through unchanged', () => {
    const t: IntDataType = { id: 'int' };
    expect(convertValue(t, null)).toBeNull();
    expect(convertValue(t, undefined)).toBeUndefined();
  });

  describe('int / long', () => {
    const t: IntDataType = { id: 'int' };

    it('truncates decimal strings', () => {
      expect(convertValue(t, '3.9')).toBe(3);
    });
    it('converts numeric string', () => {
      expect(convertValue(t, '42')).toBe(42);
    });
    it('passes through non-numeric as-is', () => {
      expect(convertValue(t, 'abc')).toBe('abc');
    });
  });

  describe('float / double', () => {
    const t: FloatDataType = { id: 'float', scale: 2 };

    it('rounds to scale', () => {
      expect(convertValue(t, '3.14159')).toBe(3.14);
    });
    it('handles number input', () => {
      expect(convertValue(t, 3.14159)).toBe(3.14);
    });
    it('no scale → raw float', () => {
      const t2: FloatDataType = { id: 'float' };
      expect(convertValue(t2, '1.5')).toBe(1.5);
    });
  });

  describe('boolean', () => {
    it('passes through JS boolean', () => {
      const t: BooleanDataType = { id: 'boolean' };
      expect(convertValue(t, true)).toBe(true);
      expect(convertValue(t, false)).toBe(false);
    });
    it('converts custom true/false values', () => {
      const t: BooleanDataType = { id: 'boolean', trueValue: '1', falseValue: '0' };
      expect(convertValue(t, '1')).toBe(true);
      expect(convertValue(t, '0')).toBe(false);
    });
    it('defaults to Boolean() for unknown', () => {
      const t: BooleanDataType = { id: 'boolean' };
      expect(convertValue(t, 1)).toBe(true);
      expect(convertValue(t, 0)).toBe(false);
    });
  });

  describe('enum', () => {
    const t: EnumDataType = {
      id: 'enum',
      elements: [
        { value: 1, text: 'Online' },
        { value: 0, text: 'Offline' },
      ],
    };

    it('maps matching value', () => {
      expect(convertValue(t, 1)).toBe(1);
      expect(convertValue(t, '1')).toBe(1); // string → number match
    });
    it('returns raw value when no match', () => {
      expect(convertValue(t, 99)).toBe(99);
    });
  });

  describe('date', () => {
    it('converts Date to timestamp', () => {
      const t: DateDataType = { id: 'date' };
      const d = new Date('2024-01-01T00:00:00Z');
      expect(convertValue(t, d)).toBe(d.getTime());
    });
    it('passes through numeric timestamp', () => {
      const t: DateDataType = { id: 'date' };
      expect(convertValue(t, 1_700_000_000_000)).toBe(1_700_000_000_000);
    });
  });

  it('string → String()', () => {
    expect(convertValue({ id: 'string' }, 42)).toBe('42');
  });

  it('json/geo/array → raw passthrough', () => {
    const obj = { a: 1 };
    expect(convertValue({ id: 'json' }, obj)).toBe(obj);
  });
});
