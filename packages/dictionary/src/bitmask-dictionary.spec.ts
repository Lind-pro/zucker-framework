import { describe, it, expect } from 'vitest';
import { BitMaskDictionary } from './bitmask-dictionary';
import type { EnumDictItem } from './enum-dict';
import type { DictionaryItem } from './index';

const ITEMS: EnumDictItem[] = [
  { value: 'read', text: 'Read', ordinal: 0 },
  { value: 'write', text: 'Write', ordinal: 1 },
  { value: 'exec', text: 'Execute', ordinal: 2 },
];

describe('BitMaskDictionary', () => {
  it('should encode boolean array to bitmask', () => {
    expect(BitMaskDictionary.encode([true, false, true])).toBe(0b101);
    expect(BitMaskDictionary.encode([true, true, true])).toBe(0b111);
    expect(BitMaskDictionary.encode([false, false, false])).toBe(0);
  });

  it('should decode bitmask to boolean array', () => {
    expect(BitMaskDictionary.decode(0b101, 3)).toEqual([true, false, true]);
    expect(BitMaskDictionary.decode(0b111, 3)).toEqual([true, true, true]);
    expect(BitMaskDictionary.decode(0, 3)).toEqual([false, false, false]);
  });

  it('should check if a specific bit is set with has()', () => {
    expect(BitMaskDictionary.has(0b101, 0)).toBe(true);
    expect(BitMaskDictionary.has(0b101, 1)).toBe(false);
    expect(BitMaskDictionary.has(0b101, 2)).toBe(true);
  });

  it('should set and clear bits with set()', () => {
    expect(BitMaskDictionary.set(0b100, 0, true)).toBe(0b101);
    expect(BitMaskDictionary.set(0b111, 1, false)).toBe(0b101);
  });

  it('should compute toMask from EnumDictItems', () => {
    expect(BitMaskDictionary.toMask([ITEMS[0], ITEMS[2]])).toBe(0b101);
    expect(BitMaskDictionary.toMask(ITEMS)).toBe(0b111);
  });

  it('should throw for more than 64 items in toMask', () => {
    const manyItems = Array.from({ length: 64 }, (_, i) => ({
      value: `v${i}`, text: `t${i}`, ordinal: i,
    }));
    expect(() => BitMaskDictionary.toMask(manyItems)).toThrow('64');
  });

  it('should get items by mask with getByMask()', () => {
    const result = BitMaskDictionary.getByMask(ITEMS, 0b011);
    expect(result).toEqual([ITEMS[0], ITEMS[1]]);
  });

  it('should check maskIn (ALL targets present)', () => {
    expect(BitMaskDictionary.maskIn(0b111, [ITEMS[0], ITEMS[2]])).toBe(true);
    expect(BitMaskDictionary.maskIn(0b001, [ITEMS[0], ITEMS[1]])).toBe(false);
  });

  it('should check maskInAny (ANY target present)', () => {
    expect(BitMaskDictionary.maskInAny(0b001, [ITEMS[0], ITEMS[2]])).toBe(true);
    expect(BitMaskDictionary.maskInAny(0b010, [ITEMS[0], ITEMS[2]])).toBe(false);
  });

  it('should check itemIn', () => {
    expect(BitMaskDictionary.itemIn(0b101, ITEMS[0])).toBe(true);
    expect(BitMaskDictionary.itemIn(0b101, ITEMS[1])).toBe(false);
  });

  it('should decode to labels with toLabels()', () => {
    const dictItems: DictionaryItem[] = ITEMS.map((i, idx) => ({
      id: `id-${idx}`,
      dictId: 'perms',
      name: i.text,
      value: String(i.value),
      text: i.text,
      ordinal: i.ordinal,
      parentId: null,
      path: `/${i.value}`,
      sortIndex: idx,
    }));
    expect(BitMaskDictionary.toLabels(0b101, dictItems)).toEqual(['Read', 'Execute']);
  });

  it('should decode to items with toItems()', () => {
    const dictItems: DictionaryItem[] = ITEMS.map((i, idx) => ({
      id: `id-${idx}`,
      dictId: 'perms',
      name: i.text,
      value: String(i.value),
      text: i.text,
      ordinal: i.ordinal,
      parentId: null,
      path: `/${i.value}`,
      sortIndex: idx,
    }));
    const result = BitMaskDictionary.toItems(0b010, dictItems);
    expect(result).toEqual([{ value: 'write', text: 'Write' }]);
  });
});
