import { describe, it, expect, beforeEach } from 'vitest';
import {
  enumDictEq,
  enumDictIn,
  getMask,
  toMask,
  getByMask,
  maskIn,
  maskInAny,
  getWriteJSONObject,
  EnumDictRegistry,
} from './enum-dict';
import type { EnumDictItem } from './enum-dict';

const ITEM_A: EnumDictItem = { value: 'a', text: 'Alpha', ordinal: 0 };
const ITEM_B: EnumDictItem = { value: 'b', text: 'Beta', ordinal: 1 };
const ITEM_C: EnumDictItem = { value: 'c', text: 'Gamma', ordinal: 2 };

describe('enumDictEq', () => {
  it('should match by value', () => {
    expect(enumDictEq(ITEM_A, 'a')).toBe(true);
  });

  it('should match by text (case-insensitive)', () => {
    expect(enumDictEq(ITEM_A, 'ALPHA')).toBe(true);
    expect(enumDictEq(ITEM_A, 'alpha')).toBe(true);
  });

  it('should match by ordinal', () => {
    expect(enumDictEq(ITEM_B, 1)).toBe(true);
  });

  it('should match from object with value key', () => {
    expect(enumDictEq(ITEM_A, { value: 'a' })).toBe(true);
  });

  it('should match from object with text key', () => {
    expect(enumDictEq(ITEM_A, { text: 'Alpha' })).toBe(true);
  });

  it('should match from array (any element)', () => {
    expect(enumDictEq(ITEM_A, ['x', 'a'])).toBe(true);
    expect(enumDictEq(ITEM_A, ['x', 'y'])).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(enumDictEq(ITEM_A, null)).toBe(false);
    expect(enumDictEq(ITEM_A, undefined)).toBe(false);
  });

  it('should not match non-matching values', () => {
    expect(enumDictEq(ITEM_A, 'zzz')).toBe(false);
  });
});

describe('bitmask functions (getMask, toMask, getByMask, maskIn, maskInAny)', () => {
  it('getMask should return 2^index', () => {
    expect(getMask(0)).toBe(1);
    expect(getMask(1)).toBe(2);
    expect(getMask(3)).toBe(8);
  });

  it('toMask should combine ordinals', () => {
    expect(toMask([ITEM_A, ITEM_C])).toBe(0b101); // bit 0 + bit 2
  });

  it('getByMask should return items matching the mask', () => {
    const items = [ITEM_A, ITEM_B, ITEM_C];
    const result = getByMask(items, 0b101);
    expect(result).toEqual([ITEM_A, ITEM_C]);
  });

  it('maskIn should check ALL targets present', () => {
    const mask = toMask([ITEM_A, ITEM_B, ITEM_C]); // 0b111
    expect(maskIn(mask, ITEM_A, ITEM_B)).toBe(true);
    expect(maskIn(0b001, ITEM_A, ITEM_B)).toBe(false);
  });

  it('maskInAny should check ANY target present', () => {
    expect(maskInAny(0b001, ITEM_A, ITEM_B)).toBe(true);
    expect(maskInAny(0b100, ITEM_A)).toBe(false);
  });
});

describe('getWriteJSONObject', () => {
  it('should return {value, text} object', () => {
    expect(getWriteJSONObject(ITEM_A)).toEqual({ value: 'a', text: 'Alpha' });
  });

  it('should use textResolver for i18n', () => {
    const item: EnumDictItem = { value: 'x', text: 'X', ordinal: 0, i18nCode: 'dict.x' };
    const resolver = (code: string) => `[${code}]`;
    expect(getWriteJSONObject(item, resolver)).toEqual({ value: 'x', text: '[dict.x]' });
  });
});

describe('EnumDictRegistry', () => {
  beforeEach(() => {
    EnumDictRegistry.clear();
  });

  it('should register and retrieve items', () => {
    EnumDictRegistry.register('test', [ITEM_A, ITEM_B]);
    expect(EnumDictRegistry.get('test')).toEqual([ITEM_A, ITEM_B]);
    expect(EnumDictRegistry.has('test')).toBe(true);
  });

  it('should register from TypeScript enum', () => {
    enum Status { ONLINE = 'online', OFFLINE = 'offline' }
    EnumDictRegistry.registerEnum('status', Status);
    const items = EnumDictRegistry.get('status');
    expect(items).toBeDefined();
    expect(items!.length).toBe(2);
    expect(items![0].value).toBe('online');
  });

  it('should find by value (case-insensitive)', () => {
    EnumDictRegistry.register('test', [ITEM_A, ITEM_B]);
    expect(EnumDictRegistry.findByValue('test', 'A')).toEqual(ITEM_A);
  });

  it('should find by text (case-insensitive)', () => {
    EnumDictRegistry.register('test', [ITEM_A]);
    expect(EnumDictRegistry.findByText('test', 'ALPHA')).toEqual(ITEM_A);
  });

  it('should find by eq semantics', () => {
    EnumDictRegistry.register('test', [ITEM_A, ITEM_B]);
    expect(EnumDictRegistry.findByEq('test', { value: 'b' })).toEqual(ITEM_B);
  });

  it('should find by predicate', () => {
    EnumDictRegistry.register('test', [ITEM_A, ITEM_B, ITEM_C]);
    expect(EnumDictRegistry.find('test', (i) => i.ordinal === 2)).toEqual(ITEM_C);
  });

  it('should findList by predicate', () => {
    EnumDictRegistry.register('test', [ITEM_A, ITEM_B, ITEM_C]);
    const result = EnumDictRegistry.findList('test', (i) => i.ordinal >= 1);
    expect(result).toHaveLength(2);
  });

  it('should return undefined for non-existent dict', () => {
    expect(EnumDictRegistry.get('nope')).toBeUndefined();
    expect(EnumDictRegistry.findByValue('nope', 'x')).toBeUndefined();
  });
});

describe('enumDictIn', () => {
  it('should return true when target is among candidates', () => {
    expect(enumDictIn(ITEM_A, ITEM_A, ITEM_B)).toBe(true);
    expect(enumDictIn(ITEM_B, ITEM_A, ITEM_B, ITEM_C)).toBe(true);
  });

  it('should return false when target is not among candidates', () => {
    expect(enumDictIn(ITEM_C, ITEM_A, ITEM_B)).toBe(false);
  });

  it('should handle large candidate sets (>=64) using Set fallback', () => {
    const many: EnumDictItem[] = Array.from({ length: 65 }, (_, i) => ({
      value: `v${i}`, text: `T${i}`, ordinal: i,
    }));
    const target = many[32];
    expect(enumDictIn(target, ...many)).toBe(true);

    const outsider: EnumDictItem = { value: 'nope', text: 'Nope', ordinal: 99 };
    expect(enumDictIn(outsider, ...many)).toBe(false);
  });
});
