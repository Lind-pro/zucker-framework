/**
 * Diff — 对象差异对比
 * 参考: hsweb-framework Diff.java, CompareUtils.java
 *
 * 对比 hsweb CompareUtils:
 * - 原实现使用 JSON.stringify 比较，key 顺序不同时会误判
 * - 改进: 递归深度比较，支持 Date、数字精度、集合对比
 */

/**
 * Represents a single field-level change between two objects.
 */
export interface FieldChange {
  /** The field name that changed */
  field: string;
  /** The previous value */
  oldValue: unknown;
  /** The new value */
  newValue: unknown;
}

/**
 * Compute the difference between two objects, returning changed fields.
 * Uses deep equality comparison, supporting Date, Map, Set, and nested objects.
 * @param oldObj - The original object
 * @param newObj - The updated object
 * @param ignoreFields - Field names to exclude from comparison
 * @returns An array of field changes
 *
 * @example
 * ```ts
 * diff({ name: 'Alice', age: 30 }, { name: 'Bob', age: 30 });
 * // [{ field: 'name', oldValue: 'Alice', newValue: 'Bob' }]
 * ```
 */
export function diff(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  ignoreFields: string[] = [],
): FieldChange[] {
  const changes: FieldChange[] = [];
  const ignoreSet = new Set(ignoreFields);
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    if (ignoreSet.has(key)) continue;

    const oldValue = oldObj[key];
    const newValue = newObj[key];

    if (oldValue === undefined && newValue === undefined) continue;

    if (!deepEquals(oldValue, newValue)) {
      changes.push({ field: key, oldValue, newValue });
    }
  }

  return changes;
}

/**
 * Deep equality comparison supporting cross-type comparison.
 * Handles Date, Array, Map, Set, and nested objects. Unlike JSON.stringify,
 * this function is not sensitive to key ordering in objects.
 * @param a - First value to compare
 * @param b - Second value to compare
 * @returns True if the values are deeply equal
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  // 引用相等
  if (a === b) return true;

  // null/undefined
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b;
  }

  // Date 比较（参考 hsweb CompareUtils.compare(Date, Object)）
  // 必须在 typeof 分支之前处理，因为 typeof Date === 'object'
  // 而 Date vs number/string 会被 typeof 短路返回 false
  if (a instanceof Date || b instanceof Date) {
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    // Date vs number — 时间戳比较（参考 hsweb: date.getTime() == number.longValue()）
    if (a instanceof Date && typeof b === 'number') {
      return a.getTime() === b;
    }
    if (typeof a === 'number' && b instanceof Date) {
      return a === b.getTime();
    }
    // Date vs string — ISO 格式比较（参考 hsweb: DateFormatter 格式化后比较）
    if (a instanceof Date && typeof b === 'string') {
      const parsed = new Date(b);
      return !isNaN(parsed.getTime()) && a.getTime() === parsed.getTime();
    }
    if (typeof a === 'string' && b instanceof Date) {
      const parsed = new Date(a);
      return !isNaN(parsed.getTime()) && parsed.getTime() === b.getTime();
    }
    return false;
  }

  // 类型不同
  if (typeof a !== typeof b) {
    // 数字与字符串的跨类型比较（参考 hsweb CompareUtils.compare(Number, Object)）
    if (typeof a === 'number' && typeof b === 'string') {
      const n = Number(b);
      return !isNaN(n) && a === n;
    }
    if (typeof a === 'string' && typeof b === 'number') {
      const n = Number(a);
      return !isNaN(n) && n === b;
    }
    // 布尔与字符串的跨类型比较（参考 hsweb CompareUtils.compare(Boolean, Object)）
    if (typeof a === 'boolean' && typeof b === 'string') {
      return String(a) === b;
    }
    if (typeof a === 'string' && typeof b === 'boolean') {
      return a === String(b);
    }
    // 布尔与数字的跨类型比较
    if (typeof a === 'boolean' && typeof b === 'number') {
      return (a ? 1 : 0) === b;
    }
    if (typeof a === 'number' && typeof b === 'boolean') {
      return a === (b ? 1 : 0);
    }
    return false;
  }

  // 数组比较
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  // 数组 vs 字符串（参考 hsweb CompareUtils: source instanceof String => split("[, ;]")）
  if (Array.isArray(a) && typeof b === 'string') {
    return collectionEquals(a, b.split(/[,; ]/));
  }
  if (typeof a === 'string' && Array.isArray(b)) {
    return collectionEquals(a.split(/[,; ]/), b);
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  // Map 比较
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || !deepEquals(val, b.get(key))) return false;
    }
    return true;
  }

  // Set 比较
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const val of a) {
      if (!b.has(val)) return false;
    }
    return true;
  }

  // 普通对象比较（不使用 JSON.stringify，避免 key 顺序问题）
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;

    for (const key of aKeys) {
      if (!(key in bObj)) return false;
      if (!deepEquals(aObj[key], bObj[key])) return false;
    }

    return true;
  }

  return false;
}

/**
 * 集合无序比较
 * 参考 hsweb CompareUtils.compare(Collection, Object)
 *
 * hsweb 的 Collection 比较逻辑:
 * 1. 将两边都转为 Set
 * 2. 较大集合的每个元素在较小集合中 anyMatch(deepEquals)
 */
export function collectionEquals(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  // 对齐 hsweb: 转 Set 后逐项 anyMatch
  for (const item of a) {
    if (!b.some((bItem) => deepEquals(item, bItem))) {
      return false;
    }
  }
  return true;
}
