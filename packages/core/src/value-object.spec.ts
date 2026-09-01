import { describe, it, expect } from 'vitest';
import { ValueObject } from './value-object';

describe('ValueObject', () => {
  const vo = ValueObject.of({
    name: 'Alice',
    age: 30,
    score: 95.5,
    active: true,
    birthday: new Date('1994-06-15'),
    tags: ['a', 'b'],
    address: { city: 'Beijing' },
    empty: null,
    zero: 0,
    falsy: false,
    strNum: '42',
    strBool: 'yes',
  });

  describe('get', () => {
    it('should return raw value', () => {
      expect(vo.get('name')).toBe('Alice');
    });

    it('should return undefined for missing key', () => {
      expect(vo.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getString', () => {
    it('should return string value', () => {
      expect(vo.getString('name')).toBe('Alice');
    });

    it('should convert number to string', () => {
      expect(vo.getString('age')).toBe('30');
    });

    it('should return default for null', () => {
      expect(vo.getString('empty', 'fallback')).toBe('fallback');
    });

    it('should return default for missing key', () => {
      expect(vo.getString('missing', 'default')).toBe('default');
    });
  });

  describe('getInt', () => {
    it('should return integer', () => {
      expect(vo.getInt('age')).toBe(30);
    });

    it('should truncate float to int', () => {
      expect(vo.getInt('score')).toBe(95);
    });

    it('should parse string to int', () => {
      expect(vo.getInt('strNum')).toBe(42);
    });

    it('should return default for null', () => {
      expect(vo.getInt('empty', 0)).toBe(0);
    });

    it('should return default for NaN', () => {
      expect(vo.getInt('name', -1)).toBe(-1);
    });
  });

  describe('getNumber', () => {
    it('should return number value', () => {
      expect(vo.getNumber('score')).toBe(95.5);
    });

    it('should parse string to number', () => {
      expect(vo.getNumber('strNum')).toBe(42);
    });

    it('should return default for NaN', () => {
      expect(vo.getNumber('name', -1)).toBe(-1);
    });
  });

  describe('getBoolean', () => {
    it('should return boolean value', () => {
      expect(vo.getBoolean('active')).toBe(true);
      expect(vo.getBoolean('falsy')).toBe(false);
    });

    it('should parse "yes" as true', () => {
      expect(vo.getBoolean('strBool')).toBe(true);
    });

    it('should return default for null', () => {
      expect(vo.getBoolean('empty', false)).toBe(false);
    });

    it('should return default for unparseable values', () => {
      expect(vo.getBoolean('name', false)).toBe(false);
    });
  });

  describe('getDate', () => {
    it('should return Date value', () => {
      const d = vo.getDate('birthday');
      expect(d).toBeInstanceOf(Date);
      expect(d!.getFullYear()).toBe(1994);
    });

    it('should return undefined for null', () => {
      expect(vo.getDate('empty')).toBeUndefined();
    });

    it('should return undefined for invalid date string', () => {
      const v = ValueObject.of({ bad: 'not-a-date' });
      expect(v.getDate('bad')).toBeUndefined();
    });
  });

  describe('getArray', () => {
    it('should return array value', () => {
      expect(vo.getArray('tags')).toEqual(['a', 'b']);
    });

    it('should return empty array for non-array', () => {
      expect(vo.getArray('name')).toEqual([]);
    });

    it('should return empty array for missing key', () => {
      expect(vo.getArray('missing')).toEqual([]);
    });
  });

  describe('getObject', () => {
    it('should return object value', () => {
      expect(vo.getObject('address')).toEqual({ city: 'Beijing' });
    });

    it('should return undefined for non-object', () => {
      expect(vo.getObject('name')).toBeUndefined();
    });

    it('should return undefined for array', () => {
      expect(vo.getObject('tags')).toBeUndefined();
    });
  });

  describe('getOrThrow', () => {
    it('should return value for existing key', () => {
      expect(vo.getOrThrow('name')).toBe('Alice');
    });

    it('should throw for null value', () => {
      expect(() => vo.getOrThrow('empty')).toThrow('Required value "empty" is missing');
    });

    it('should throw for missing key', () => {
      expect(() => vo.getOrThrow('missing')).toThrow('Required value "missing" is missing');
    });
  });

  describe('has', () => {
    it('should return true for existing non-null values', () => {
      expect(vo.has('name')).toBe(true);
      expect(vo.has('zero')).toBe(true);
      expect(vo.has('falsy')).toBe(true);
    });

    it('should return false for null', () => {
      expect(vo.has('empty')).toBe(false);
    });

    it('should return false for missing', () => {
      expect(vo.has('missing')).toBe(false);
    });
  });

  describe('toRecord', () => {
    it('should return a copy of the values', () => {
      const record = vo.toRecord();
      expect(record.name).toBe('Alice');
      // Ensure it's a copy
      record.name = 'modified';
      expect(vo.getString('name')).toBe('Alice');
    });
  });
});
