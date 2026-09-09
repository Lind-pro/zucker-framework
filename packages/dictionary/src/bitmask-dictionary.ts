import type { DictionaryItem } from './index';
import type { EnumDictItem } from './enum-dict';

/**
 * BitMaskDictionary — bitmask dictionary utility class.
 *
 * Encodes multi-select values as bitmask integers for efficient storage and querying.
 * Each dictionary item corresponds to a bit; the bit index is determined by item order (ordinal).
 */
export class BitMaskDictionary {
  /**
   * Encode a boolean array as a bitmask integer.
   *
   * @param flags - Each position corresponds to whether an option is selected
   * @returns Bitmask integer
   */
  static encode(flags: boolean[]): number {
    let value = 0;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i]) {
        value |= 1 << i;
      }
    }
    return value;
  }

  /**
   * Decode a bitmask integer to a boolean array.
   *
   * @param value - Bitmask integer
   * @param length - Array length (number of dictionary items)
   * @returns Boolean array
   */
  static decode(value: number, length: number): boolean[] {
    const flags: boolean[] = [];
    for (let i = 0; i < length; i++) {
      flags.push((value & (1 << i)) !== 0);
    }
    return flags;
  }

  /**
   * Check if a specific bit is set.
   *
   * @param value - Bitmask integer
   * @param index - Bit index (0-based)
   * @returns Whether the bit is 1
   */
  static has(value: number, index: number): boolean {
    return (value & (1 << index)) !== 0;
  }

  /**
   * Set or clear a specific bit.
   *
   * @param value - Original bitmask integer
   * @param index - Bit index (0-based)
   * @param flag - true to set, false to clear
   * @returns New bitmask integer
   */
  static set(value: number, index: number, flag: boolean): number {
    if (flag) {
      return value | (1 << index);
    }
    return value & ~(1 << index);
  }

  /**
   * Compute a bitmask from EnumDictItems using their ordinal values.
   *
   * @param items - Items to include in the mask
   * @returns Bitmask integer
   */
  static toMask(items: EnumDictItem[]): number {
    if (items.length >= 64) {
      throw new Error('Bitmask operations do not support more than 64 items');
    }
    let value = 0;
    for (const item of items) {
      value |= 1 << item.ordinal;
    }
    return value;
  }

  /**
   * Convert a bitmask to a number (identity — for API symmetry).
   *
   * @param items - Items to include
   * @returns Bitmask number
   */
  static toMaskNumber(items: EnumDictItem[]): number {
    return BitMaskDictionary.toMask(items);
  }

  /**
   * Get all EnumDictItems that match a bitmask.
   *
   * @param allItems - All available items
   * @param mask - Bitmask to test against
   * @returns Items whose ordinal bit is set in the mask
   */
  static getByMask<T extends EnumDictItem>(allItems: T[], mask: number): T[] {
    if (allItems.length >= 64) {
      throw new Error('Bitmask operations do not support more than 64 items');
    }
    return allItems.filter((item) => (mask & (1 << item.ordinal)) !== 0);
  }

  /**
   * Check if ALL of the target items are present in the mask.
   */
  static maskIn(mask: number, targets: EnumDictItem[]): boolean {
    const targetMask = BitMaskDictionary.toMask(targets);
    return (mask & targetMask) === targetMask;
  }

  /**
   * Check if ANY of the target items are present in the mask.
   */
  static maskInAny(mask: number, targets: EnumDictItem[]): boolean {
    const targetMask = BitMaskDictionary.toMask(targets);
    return (mask & targetMask) !== 0;
  }

  /**
   * Check if a specific EnumDictItem is in the mask.
   */
  static itemIn(mask: number, item: EnumDictItem): boolean {
    return (mask & (1 << item.ordinal)) !== 0;
  }

  /**
   * Decode a bitmask to corresponding dictionary item labels.
   *
   * @param value - Bitmask integer
   * @param items - Dictionary items (ordered by position)
   * @returns Text labels for selected items
   */
  static toLabels(value: number, items: DictionaryItem[]): string[] {
    const labels: string[] = [];
    for (let i = 0; i < items.length; i++) {
      if ((value & (1 << i)) !== 0) {
        labels.push(items[i].text);
      }
    }
    return labels;
  }

  /**
   * Decode a bitmask to corresponding dictionary item labels with i18n support.
   *
   * @param value - Bitmask integer
   * @param items - Dictionary items (ordered by position)
   * @param textResolver - i18n text resolver function
   * @returns Translated text labels for selected items
   */
  static toI18nLabels(
    value: number,
    items: DictionaryItem[],
    textResolver: (text: string) => string,
  ): string[] {
    const labels: string[] = [];
    for (let i = 0; i < items.length; i++) {
      if ((value & (1 << i)) !== 0) {
        labels.push(textResolver(items[i].text));
      }
    }
    return labels;
  }

  /**
   * Decode a bitmask to {value, text} structures.
   *
   * @param value - Bitmask integer
   * @param items - Dictionary items
   * @param textResolver - Optional i18n text resolver
   */
  static toItems(
    value: number,
    items: DictionaryItem[],
    textResolver?: (text: string) => string,
  ): Array<{ value: string; text: string }> {
    const result: Array<{ value: string; text: string }> = [];
    for (let i = 0; i < items.length; i++) {
      if ((value & (1 << i)) !== 0) {
        const text = textResolver ? textResolver(items[i].text) : items[i].text;
        result.push({ value: items[i].value, text });
      }
    }
    return result;
  }
}
