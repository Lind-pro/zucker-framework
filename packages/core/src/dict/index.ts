/**
 * 枚举字典系统
 *
 * EnumDict 提供了一种将枚举值与显示文本关联的标准方式，
 * 支持位掩码操作、跨类型值比较等功能。
 */

/**
 * 字典项接口
 */
export interface EnumDict<V = string> {
  /** 值 — 对应数据库存储值 */
  readonly value: V;
  /** 显示文本 */
  readonly text: string;
  /** 序号 */
  readonly ordinal: number;
  /** 描述（默认等于 text） */
  readonly comments?: string;
}

/**
 * 获取字典项的位掩码
 *
 * 注: JS 位运算为 32 位有符号，ordinal 应在 0..30 范围内。
 */
export function getMask(dict: EnumDict): number {
  return 1 << dict.ordinal;
}

/**
 * 判断字典项是否在掩码中
 */
export function isInMask(dict: EnumDict, mask: number): boolean {
  return (mask & getMask(dict)) !== 0;
}

/**
 * 将多个字典项合并为掩码值
 */
export function toMask(...dicts: EnumDict[]): number {
  let value = 0;
  for (const d of dicts) {
    value |= getMask(d);
  }
  return value;
}

/**
 * 判断掩码是否包含所有指定的字典项
 */
export function maskIn(mask: number, ...dicts: EnumDict[]): boolean {
  const value = toMask(...dicts);
  return (mask & value) === value;
}

/**
 * 判断掩码是否包含任意一个指定的字典项
 */
export function maskInAny(mask: number, ...dicts: EnumDict[]): boolean {
  const value = toMask(...dicts);
  return (mask & value) !== 0;
}

/**
 * 从掩码中获取匹配的字典项列表
 */
export function getByMask<T extends EnumDict>(allOptions: T[], mask: number): T[] {
  if (allOptions.length >= 64) {
    throw new Error('EnumDict does not support more than 64 options');
  }
  return allOptions.filter((t) => isInMask(t, mask));
}

/**
 * 字典项值比较 — 支持跨类型对比
 *
 * 比较规则：
 * 1. null/undefined 不匹配
 * 2. 数组中的任一元素递归匹配即可
 * 3. Map 优先读取 value 键，键不存在时读取 text
 * 4. 数字截断为整数后参与比较
 * 5. EnumDict 取 value（空值则取 text）再递归比较
 * 6. 普通对象提取 value/text 后递归比较
 * 7. 比较 value、ordinal，或忽略大小写比较 value/text
 */
export function dictEq(dict: EnumDict, v: unknown): boolean {
  if (v === null || v === undefined) return false;

  // 数组中任意匹配
  if (Array.isArray(v)) {
    return v.some((item) => dictEq(dict, item));
  }

  // Map 对象取 value 或 text
  if (v instanceof Map) {
    const resolved = v.has('value') ? v.get('value') : v.get('text');
    return dictEq(dict, resolved);
  }

  // Number -> 取整数值
  if (typeof v === 'number') {
    v = Math.trunc(v);
  }

  // EnumDict 对象
  if (typeof v === 'object' && v !== null && 'value' in v && 'text' in v && 'ordinal' in v) {
    const d = v as EnumDict;
    const resolved = d.value ?? d.text;
    return dictEq(dict, resolved);
  }

  // 普通对象带 value/text 属性
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    const resolved = 'value' in obj ? obj['value'] : ('text' in obj ? obj['text'] : undefined);
    if (resolved !== undefined) {
      return dictEq(dict, resolved);
    }
  }

  // 比较值和序号，再忽略大小写比较值和文本
  return (
    dict.value === v ||
    dict.ordinal === v ||
    String(dict.value).toLowerCase() === String(v).toLowerCase() ||
    dict.text.toLowerCase() === String(v).toLowerCase()
  );
}

/**
 * 从字典列表中按值查找
 *
 * 空值提前返回
 * 支持数字类型 value 的跨类型匹配
 */
export function findByValue<T extends EnumDict>(items: T[], value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  return items.find(
    (e) =>
      e.value === value ||
      // 跨类型数值比较 (string "1" == number 1)
      // eslint-disable-next-line eqeqeq
      e.value == value ||
      String(e.value).toLowerCase() === String(value).toLowerCase(),
  );
}

/**
 * 从字典列表中按文本查找
 */
export function findByText<T extends EnumDict>(items: T[], text: string): T | undefined {
  return items.find((e) => e.text.toLowerCase() === text.toLowerCase());
}

/**
 * 从字典列表中按值或文本查找
 */
export function findDict<T extends EnumDict>(items: T[], target: unknown): T | undefined {
  return items.find((e) => dictEq(e, target));
}

/**
 * 创建动态字典项
 */
export function createDictItem(value: string, text?: string): EnumDict<string> {
  return {
    value,
    text: text ?? value,
    ordinal: 0,
  };
}

/**
 * 从字典列表中按条件查找所有匹配项
 */
export function findDictList<T extends EnumDict>(items: T[], predicate: (item: T) => boolean): T[] {
  return items.filter(predicate);
}

// ---- ItemDefine: 字典项定义 ----

/**
 * 字典项定义接口
 * 提供字典项的文本、值、说明和顺序信息。
 */
export interface ItemDefine extends EnumDict<string> {
  readonly value: string;
  readonly text: string;
  readonly comments?: string;
  readonly ordinal: number;
}

/**
 * 创建默认字典项
 */
export function createItemDefine(
  value: string,
  text: string,
  ordinal = 0,
  comments?: string,
): ItemDefine {
  return { value, text, ordinal, comments };
}

// ---- DictDefine: 字典定义 ----

/**
 * 字典定义接口
 */
export interface DictDefine {
  id: string;
  alias: string;
  comments?: string;
  items: EnumDict[];
}

/**
 * 类字段关联的字典定义
 * 通过 field 属性标识关联的类字段名。
 */
export interface ClassDictDefine extends DictDefine {
  field: string;
}

/**
 * 字典定义仓库接口
 */
export interface DictDefineRepository {
  getDefine(id: string): DictDefine | undefined;
  getAllDefines(): DictDefine[];
  addDefine(define: DictDefine): void;
}

/**
 * 内存字典定义仓库
 */
export class DefaultDictDefineRepository implements DictDefineRepository {
  private readonly defines = new Map<string, DictDefine>();

  getDefine(id: string): DictDefine | undefined {
    return this.defines.get(id);
  }

  getAllDefines(): DictDefine[] {
    return [...this.defines.values()];
  }

  addDefine(define: DictDefine): void {
    this.defines.set(define.id, define);
  }
}

/**
 * 从枚举风格的对象数组中解析字典定义
 *
 * @param id - 字典 ID
 * @param items - 枚举项数组（需至少包含 value 和 text）
 * @param options - 可选的 alias 和 comments
 */
export function parseDictDefine(
  id: string,
  items: EnumDict[],
  options?: { alias?: string; comments?: string },
): DictDefine {
  return {
    id,
    alias: options?.alias ?? id,
    comments: options?.comments,
    items,
  };
}
