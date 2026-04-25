/**
 * EnumDict — maps TypeScript enums to dictionary items.
 *
 * Reference: hsweb-framework EnumDict
 *
 * Provides:
 * - getValue / getText / ordinal — core item accessors
 * - eq — flexible equality check (value, text, map, EnumDictItem)
 * - find / findByValue / findByText — lookup helpers
 * - getWriteJSONObject — serialization format {value, text}
 * - i18n support via getI18nCode / getI18nMessage
 * - comments — optional description
 * - Bitmask: getMask / toMask / getByMask / maskIn / maskInAny
 */

const ENUM_DICT_KEY = Symbol('ENUM_DICT');

export interface EnumDictItem {
  value: string | number;
  text: string;
  ordinal: number;
  /** Optional description / comments for this item */
  comments?: string;
  /** Optional i18n code; defaults to text */
  i18nCode?: string;
}

/**
 * I18nEnumDictItem — enum dict item with automatic i18n code generation.
 *
 * Reference: hsweb I18nEnumDict
 *
 * The i18n code is generated from className + "." + name, allowing
 * automatic locale resolution via message bundles.
 *
 * Example: For className="DeviceState", name="online"
 *   -> i18nCode = "DeviceState.online"
 */
export interface I18nEnumDictItem extends EnumDictItem {
  /** The enum member name (like Java Enum.name()) */
  name: string;
  /** The class/enum name for i18n code generation */
  className: string;
}

/**
 * Create an I18nEnumDictItem with auto-generated i18n code.
 *
 * Reference: hsweb I18nEnumDict.getI18nCode() -> this.getClass().getName() + "." + name()
 */
export function createI18nEnumDictItem(
  className: string,
  name: string,
  value: string | number,
  text: string,
  ordinal: number,
  comments?: string,
): I18nEnumDictItem {
  return {
    value,
    text,
    ordinal,
    comments,
    name,
    className,
    i18nCode: `${className}.${name}`,
  };
}

/**
 * Flexible equality check — mirrors hsweb EnumDict.eq().
 *
 * Compares against value, text, ordinal, map.value, map.text, or another EnumDictItem.
 */
export function enumDictEq(item: EnumDictItem, v: unknown): boolean {
  if (v === null || v === undefined) return false;

  // Array / collection — match any element
  if (Array.isArray(v)) {
    return v.some((el) => enumDictEq(item, el));
  }

  // Map-like object with value or text key
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    if ('value' in obj || 'text' in obj) {
      const target = obj.value ?? obj.text;
      return enumDictEq(item, target);
    }
  }

  // Direct comparison
  if (item.value === v) return true;
  if (item.ordinal === v) return true;

  // Case-insensitive string comparison
  const sv = String(v).toLowerCase();
  if (String(item.value).toLowerCase() === sv) return true;
  if (item.text.toLowerCase() === sv) return true;

  return false;
}

/**
 * Get the bitmask value for a given ordinal index.
 */
export function getMask(index: number): number {
  return 1 << index;
}

/**
 * Compute bitmask from multiple enum dict items.
 *
 * Reference: hsweb EnumDict.toMask()
 */
export function toMask(items: EnumDictItem[]): number {
  let value = 0;
  for (const item of items) {
    value |= getMask(item.ordinal);
  }
  return value;
}

/**
 * Get all items that match a bitmask.
 *
 * Reference: hsweb EnumDict.getByMask()
 */
export function getByMask<T extends EnumDictItem>(allItems: T[], mask: number): T[] {
  if (allItems.length >= 64) {
    throw new Error('Bitmask operations do not support more than 64 items');
  }
  return allItems.filter((item) => (mask & getMask(item.ordinal)) !== 0);
}

/**
 * Check if ALL of the target items are present in the mask.
 *
 * Reference: hsweb EnumDict.maskIn()
 */
export function maskIn(mask: number, ...targets: EnumDictItem[]): boolean {
  const targetMask = toMask(targets);
  return (mask & targetMask) === targetMask;
}

/**
 * Check if ANY of the target items are present in the mask.
 *
 * Reference: hsweb EnumDict.maskInAny()
 */
export function maskInAny(mask: number, ...targets: EnumDictItem[]): boolean {
  const targetMask = toMask(targets);
  return (mask & targetMask) !== 0;
}

/**
 * Check if a target item is contained within a set of candidates.
 *
 * For sets with fewer than 64 items, uses bitmask comparison.
 * For larger sets (>=64 items), falls back to Set-based lookup.
 *
 * Reference: hsweb EnumDict.in(T target, T... candidates)
 */
export function enumDictIn(target: EnumDictItem, ...candidates: EnumDictItem[]): boolean {
  if (candidates.length >= 64) {
    const candidateSet = new Set(candidates.map((c) => c.value));
    return candidateSet.has(target.value);
  }
  return maskIn(toMask(candidates), target);
}

/**
 * Serialize an enum dict item to the JSON object format used in hsweb.
 *
 * Reference: hsweb EnumDict.getWriteJSONObject()
 */
export function getWriteJSONObject(
  item: EnumDictItem,
  textResolver?: (code: string) => string,
): Record<string, unknown> {
  const text = textResolver
    ? textResolver(item.i18nCode ?? item.text)
    : item.text;
  return { value: item.value, text };
}

/**
 * Registry for enum dictionaries.
 */
export class EnumDictRegistry {
  private static readonly registry = new Map<string, EnumDictItem[]>();
  private static readonly enumToDict = new Map<object, string>();

  static register(dictId: string, items: EnumDictItem[]): void {
    this.registry.set(dictId, items);
  }

  static registerEnum(dictId: string, enumObj: object): void {
    this.enumToDict.set(enumObj, dictId);
    const items = this.extractEnumItems(enumObj);
    this.registry.set(dictId, items);
  }

  static get(dictId: string): EnumDictItem[] | undefined {
    return this.registry.get(dictId);
  }

  static getDictId(enumObj: object): string | undefined {
    return this.enumToDict.get(enumObj);
  }

  static getAll(): Map<string, EnumDictItem[]> {
    return new Map(this.registry);
  }

  static has(dictId: string): boolean {
    return this.registry.has(dictId);
  }

  static clear(): void {
    this.registry.clear();
    this.enumToDict.clear();
  }

  /**
   * Find an item by predicate.
   *
   * Reference: hsweb EnumDict.find(Class, Predicate)
   */
  static find(
    dictId: string,
    predicate: (item: EnumDictItem) => boolean,
  ): EnumDictItem | undefined {
    return this.registry.get(dictId)?.find(predicate);
  }

  /**
   * Find all items matching a predicate.
   *
   * Reference: hsweb EnumDict.findList(Class, Predicate)
   */
  static findList(
    dictId: string,
    predicate: (item: EnumDictItem) => boolean,
  ): EnumDictItem[] {
    return this.registry.get(dictId)?.filter(predicate) ?? [];
  }

  /**
   * Find by value — supports both string and number values.
   *
   * Reference: hsweb EnumDict.findByValue()
   *
   * 对齐 hsweb 5.x fix (4c3ce4914): 空值判断优化，null/undefined 直接返回。
   * 对齐 hsweb 5.x fix (75f416a67): 支持数字类型的 value（EnumDict<Integer>）。
   * 查找优先级：直接相等 > 数值相等（string "1" matches number 1）> 大小写不敏感字符串比较。
   */
  static findByValue(
    dictId: string,
    value: unknown,
  ): EnumDictItem | undefined {
    if (value === null || value === undefined) return undefined;
    const items = this.registry.get(dictId);
    if (!items) return undefined;
    return items.find(
      (item) =>
        item.value === value ||
        // 对齐 hsweb: 支持跨类型数值比较 (string "1" == number 1)
        // eslint-disable-next-line eqeqeq
        item.value == value ||
        String(item.value).toLowerCase() === String(value).toLowerCase(),
    );
  }

  /**
   * Find by text — case-insensitive comparison.
   *
   * Reference: hsweb EnumDict.findByText()
   */
  static findByText(
    dictId: string,
    text: string,
  ): EnumDictItem | undefined {
    const items = this.registry.get(dictId);
    if (!items) return undefined;
    return items.find(
      (item) => item.text.toLowerCase() === text.toLowerCase(),
    );
  }

  /**
   * Flexible find — uses eq() semantics to match by value, text, ordinal, etc.
   *
   * Reference: hsweb EnumDict.find(Class, Object)
   */
  static findByEq(
    dictId: string,
    target: unknown,
  ): EnumDictItem | undefined {
    const items = this.registry.get(dictId);
    if (!items) return undefined;
    return items.find((item) => enumDictEq(item, target));
  }

  private static extractEnumItems(enumObj: object): EnumDictItem[] {
    const items: EnumDictItem[] = [];
    const entries = Object.entries(enumObj);

    // Filter out reverse mapping entries (numeric enums produce key->value and value->key)
    let ordinal = 0;
    for (const [key, value] of entries) {
      if (typeof value === 'number') {
        // Numeric enum: key is text, value is the numeric value
        items.push({ value, text: key, ordinal: ordinal++ });
      } else if (typeof value === 'string' && !entries.some(([, v]) => v === key)) {
        // String enum: no reverse mapping
        items.push({ value, text: key, ordinal: ordinal++ });
      }
    }

    return items;
  }
}

/**
 * @EnumDict(dictId) class decorator — registers a TypeScript enum as a dictionary.
 *
 * Usage:
 * ```typescript
 * @EnumDict('device-status')
 * enum DeviceStatus {
 *   ONLINE = 'online',
 *   OFFLINE = 'offline',
 * }
 * ```
 */
export function EnumDict(dictId: string): ClassDecorator {
  return (target: Function) => {
    EnumDictRegistry.registerEnum(dictId, target as unknown as object);
  };
}

/**
 * Convert an enum value to a dict item.
 */
export function toDictItem(
  enumObj: object,
  enumValue: string | number,
): EnumDictItem | undefined {
  const dictId = EnumDictRegistry.getDictId(enumObj);
  if (!dictId) return undefined;

  const items = EnumDictRegistry.get(dictId);
  return items?.find((item) => item.value === enumValue);
}

/**
 * Convert a dict item back to an enum value.
 */
export function fromDictItem<T>(
  item: { value: string | number },
  _enumType: T,
): T[keyof T] {
  return item.value as unknown as T[keyof T];
}

/**
 * Create a dynamic EnumDictItem.
 *
 * Reference: hsweb EnumDict.create(String value) / EnumDict.create(String value, String text)
 *
 * @param value - The item value
 * @param text - The display text (defaults to value if not provided)
 * @returns A new EnumDictItem
 */
export function createEnumDictItem(
  value: string,
  text?: string,
): EnumDictItem {
  return {
    value,
    text: text ?? value,
    ordinal: 0,
  };
}
