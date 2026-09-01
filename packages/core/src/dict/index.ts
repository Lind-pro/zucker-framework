/**
 * 枚举字典系统
 * 参考: hsweb-framework EnumDict.java, ItemDefine.java, DictDefine.java
 *
 * EnumDict 提供了一种将枚举值与显示文本关联的标准方式，
 * 支持位掩码操作、跨类型值比较等功能。
 */

/**
 * 字典项接口 — 对应 hsweb EnumDict
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
 * 参考 hsweb EnumDict.getMask() — Java: return 1L << index()
 *
 * 注: JS 位运算为 32 位有符号，ordinal 应在 0..30 范围内。
 * Java 的 long 支持 0..63，但 hsweb 限制 allOptions.size() < 64。
 */
export function getMask(dict: EnumDict): number {
  return 1 << dict.ordinal;
}

/**
 * 判断字典项是否在掩码中
 * 参考 hsweb EnumDict.in(long mask)
 */
export function isInMask(dict: EnumDict, mask: number): boolean {
  return (mask & getMask(dict)) !== 0;
}

/**
 * 将多个字典项合并为掩码值
 * 参考 hsweb EnumDict.toMask(T... t)
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
 * 参考 hsweb EnumDict.maskIn(long mask, T... t)
 */
export function maskIn(mask: number, ...dicts: EnumDict[]): boolean {
  const value = toMask(...dicts);
  return (mask & value) === value;
}

/**
 * 判断掩码是否包含任意一个指定的字典项
 * 参考 hsweb EnumDict.maskInAny(long mask, T... t)
 */
export function maskInAny(mask: number, ...dicts: EnumDict[]): boolean {
  const value = toMask(...dicts);
  return (mask & value) !== 0;
}

/**
 * 从掩码中获取匹配的字典项列表
 * 参考 hsweb EnumDict.getByMask(List<T>, long)
 */
export function getByMask<T extends EnumDict>(allOptions: T[], mask: number): T[] {
  if (allOptions.length >= 64) {
    throw new Error('EnumDict does not support more than 64 options');
  }
  return allOptions.filter((t) => isInMask(t, mask));
}

/**
 * 字典项值比较 — 支持跨类型对比
 * 参考 hsweb EnumDict.eq(Object v)
 *
 * Java 原始逻辑顺序：
 * 1. null -> false
 * 2. Object[] -> 转 Collection 递归
 * 3. Collection -> any match
 * 4. Map -> getOrDefault("value", get("text")) 再递归
 * 5. Number -> intValue() 再参与后续比较
 * 6. EnumDict -> 取 value（null 则取 text）再递归
 * 7. 引用相等 / value 相等 / ordinal 相等 / 忽略大小写比较
 */
export function dictEq(dict: EnumDict, v: unknown): boolean {
  if (v === null || v === undefined) return false;

  // 数组/集合中任意匹配（对齐 Java: v instanceof Object[] / Collection）
  if (Array.isArray(v)) {
    return v.some((item) => dictEq(dict, item));
  }

  // Map 对象取 value 或 text（对齐 Java: v instanceof Map）
  // Java: v = map.getOrDefault("value", map.get("text"))
  if (v instanceof Map) {
    const resolved = v.has('value') ? v.get('value') : v.get('text');
    return dictEq(dict, resolved);
  }

  // Number -> 取整数值（对齐 Java: v instanceof Number -> intValue()）
  if (typeof v === 'number') {
    v = Math.trunc(v);
  }

  // EnumDict 对象（对齐 Java: v instanceof EnumDict）
  if (typeof v === 'object' && v !== null && 'value' in v && 'text' in v && 'ordinal' in v) {
    const d = v as EnumDict;
    const resolved = d.value ?? d.text;
    return dictEq(dict, resolved);
  }

  // 普通对象带 value/text 属性（对齐 Java Map 语义的 POJO 扩展）
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    // 对齐 Java: map.getOrDefault("value", map.get("text"))
    const resolved = 'value' in obj ? obj['value'] : ('text' in obj ? obj['text'] : undefined);
    if (resolved !== undefined) {
      return dictEq(dict, resolved);
    }
  }

  // 对齐 Java: this == v || getValue() == v || Objects.equals(getValue(), v)
  //           || Objects.equals(ordinal(), v)
  //           || String.valueOf(getValue()).equalsIgnoreCase(String.valueOf(v))
  //           || getText().equalsIgnoreCase(String.valueOf(v))
  return (
    dict.value === v ||
    dict.ordinal === v ||
    String(dict.value).toLowerCase() === String(v).toLowerCase() ||
    dict.text.toLowerCase() === String(v).toLowerCase()
  );
}

/**
 * 从字典列表中按值查找
 * 参考 hsweb EnumDict.findByValue(Class<T>, Object)
 *
 * 对齐 hsweb 5.x (4c3ce4914): 空值提前返回
 * 对齐 hsweb 5.x (75f416a67): 支持数字类型 value 的跨类型匹配
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
 * 参考 hsweb EnumDict.findByText(Class<T>, String)
 */
export function findByText<T extends EnumDict>(items: T[], text: string): T | undefined {
  return items.find((e) => e.text.toLowerCase() === text.toLowerCase());
}

/**
 * 从字典列表中按值或文本查找
 * 参考 hsweb EnumDict.find(Class<T>, Object)
 */
export function findDict<T extends EnumDict>(items: T[], target: unknown): T | undefined {
  return items.find((e) => dictEq(e, target));
}

/**
 * 创建动态字典项
 * 参考 hsweb EnumDict.create(String value, String text)
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
 * 参考 hsweb EnumDict.findList(Class<T>, Predicate<T>)
 */
export function findDictList<T extends EnumDict>(items: T[], predicate: (item: T) => boolean): T[] {
  return items.filter(predicate);
}

// ---- ItemDefine: 字典项定义 ----

/**
 * 字典项定义接口
 * 参考 hsweb ItemDefine — 提供 getText/getValue/getComments/getOrdinal 方法
 */
export interface ItemDefine extends EnumDict<string> {
  readonly value: string;
  readonly text: string;
  readonly comments?: string;
  readonly ordinal: number;
}

/**
 * 创建默认字典项
 * 参考 hsweb DefaultItemDefine.builder().value(...).text(...).build()
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
 * 参考 hsweb DictDefine
 */
export interface DictDefine {
  id: string;
  alias: string;
  comments?: string;
  items: EnumDict[];
}

/**
 * 类字段关联的字典定义
 * 参考 hsweb ClassDictDefine — 增加 field 属性标识关联的类字段名
 */
export interface ClassDictDefine extends DictDefine {
  field: string;
}

/**
 * 字典定义仓库接口
 * 参考 hsweb DictDefineRepository
 */
export interface DictDefineRepository {
  getDefine(id: string): DictDefine | undefined;
  getAllDefines(): DictDefine[];
  addDefine(define: DictDefine): void;
}

/**
 * 内存字典定义仓库
 * 参考 hsweb DefaultDictDefineRepository
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
 * 参考 hsweb DefaultDictDefineRepository.parseEnumDict(Class<?> type)
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
