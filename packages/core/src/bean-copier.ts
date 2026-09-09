/**
 * FastBeanCopier — 高性能对象拷贝工具
 */

/**
 * 驼峰转下划线
 *
 * 首字母大写时不添加前缀下划线，例如 "TestName" → "test_name"。
 */
export function toSnakeCase(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c >= 'A' && c <= 'Z') {
      // i !== 0 时才加下划线
      if (i !== 0) {
        result += '_';
      }
      result += c.toLowerCase();
    } else {
      result += c;
    }
  }
  return result;
}

/**
 * 下划线转驼峰
 *
 * 如果字符串同时包含大小写字母，说明已经是驼峰格式，直接返回。
 */
export function toCamelCase(str: string): string {
  let hasUpper = false;
  let hasLower = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c >= 'a' && c <= 'z') hasLower = true;
    if (c >= 'A' && c <= 'Z') hasUpper = true;
    if (hasUpper && hasLower) return str; // 已是混合大小写，无需转换
  }

  let result = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '_') {
      if (i === str.length - 1) {
        result += '_';
      } else {
        result += str[++i].toUpperCase();
      }
    } else {
      result += str[i].toLowerCase();
    }
  }
  return result;
}

/**
 * Shallow-copy properties from source to target, with optional field exclusion.
 *
 * 拷贝顺序修复：
 * 当源对象包含 extensions（扩展属性）时，应先处理 extensions 再覆盖标准属性，
 * 确保标准属性的值优先级更高。此处 extensions 字段被排除在标准拷贝之外，
 * 需要调用方自行处理 extensions 合并。
 *
 * @param source - The source object to copy from
 * @param target - The target object to copy into
 * @param ignoreFields - Field names to exclude from copying
 * @returns The modified target object
 */
export function copyProperties<T extends object>(
  source: object,
  target: T,
  ...ignoreFields: string[]
): T {
  if (source == null) return target;
  const ignoreSet = new Set(ignoreFields);
  // 默认排除 extensions 字段以避免覆盖标准属性
  // 调用方可显式处理 extensions 合并
  const srcRec = source as Record<string, unknown>;

  // 如果源对象有 extensions，先将其展开到 target（低优先级）
  if ('extensions' in srcRec && typeof srcRec.extensions === 'object' && srcRec.extensions !== null) {
    if (!ignoreSet.has('extensions')) {
      const ext = srcRec.extensions as Record<string, unknown>;
      for (const key of Object.keys(ext)) {
        if (!ignoreSet.has(key)) {
          (target as Record<string, unknown>)[key] = ext[key];
        }
      }
    }
  }

  // 再覆盖标准属性（高优先级）
  for (const key of Object.keys(srcRec)) {
    if (key === 'extensions') continue; // 已在上面处理
    if (!ignoreSet.has(key)) {
      (target as Record<string, unknown>)[key] = srcRec[key];
    }
  }
  return target;
}

/**
 * Shallow-copy properties from source to target, skipping null/undefined values.
 * Ensures existing target values are not overwritten with nulls.
 * @param source - The source object to copy from
 * @param target - The target object to copy into
 * @param ignoreFields - Field names to exclude from copying
 * @returns The modified target object
 */
export function copyNonNullProperties<T extends object>(
  source: object,
  target: T,
  ...ignoreFields: string[]
): T {
  if (source == null) return target;
  const ignoreSet = new Set(ignoreFields);
  for (const key of Object.keys(source)) {
    if (!ignoreSet.has(key)) {
      const value = (source as Record<string, unknown>)[key];
      if (value !== null && value !== undefined) {
        (target as Record<string, unknown>)[key] = value;
      }
    }
  }
  return target;
}

/**
 * Deep-merge source into target with recursive object merging.
 * Null/undefined source values are skipped (do not overwrite target).
 * @param source - Partial source data to merge
 * @param target - The target object to merge into
 * @param options - Merge options
 * @param options.arrayMerge - Array merge strategy: 'replace' (default), 'concat', or 'union'
 * @returns The modified target object
 */
export function merge<T extends object>(
  source: Partial<T>,
  target: T,
  options?: { arrayMerge?: 'replace' | 'concat' | 'union' },
): T {
  const arrayMerge = options?.arrayMerge ?? 'replace';
  for (const key of Object.keys(source) as (keyof T & string)[]) {
    const srcVal = source[key];
    if (srcVal === null || srcVal === undefined) continue;

    const tgtVal = target[key];

    // 数组合并策略
    if (Array.isArray(srcVal) && Array.isArray(tgtVal)) {
      switch (arrayMerge) {
        case 'concat':
          (target as Record<string, unknown>)[key as string] = [...tgtVal, ...srcVal];
          break;
        case 'union': {
          const set = new Set([...tgtVal, ...srcVal]);
          (target as Record<string, unknown>)[key as string] = [...set];
          break;
        }
        case 'replace':
        default:
          (target as Record<string, unknown>)[key as string] = srcVal;
          break;
      }
    } else if (
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === 'object' &&
      tgtVal !== null &&
      !Array.isArray(tgtVal) &&
      !(srcVal instanceof Date) &&
      !(tgtVal instanceof Date)
    ) {
      merge(srcVal as Record<string, unknown>, tgtVal as Record<string, unknown>, options);
    } else {
      (target as Record<string, unknown>)[key as string] = srcVal;
    }
  }
  return target;
}

/**
 * Create a deep copy of an object, supporting Date, Map, Set, and nested objects.
 * @param source - The value to deep-copy
 * @returns A new deeply-cloned instance
 */
export function deepCopy<T>(source: T): T {
  if (source === null || source === undefined) return source;
  if (typeof source !== 'object') return source;
  if (source instanceof Date) return new Date(source.getTime()) as unknown as T;
  if (Array.isArray(source)) return source.map((item) => deepCopy(item)) as unknown as T;
  if (source instanceof Map) {
    const result = new Map();
    for (const [k, v] of source) {
      result.set(deepCopy(k), deepCopy(v));
    }
    return result as unknown as T;
  }
  if (source instanceof Set) {
    const result = new Set();
    for (const v of source) {
      result.add(deepCopy(v));
    }
    return result as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = deepCopy(value);
  }
  return result as unknown as T;
}

/**
 * Flatten a nested object into dot-separated key paths.
 * @param bean - The nested object to flatten
 * @param prefix - Optional key prefix for all paths
 * @param options - Flatten options
 * @param options.maxDepth - Maximum nesting depth (default: 10)
 * @param options.expandArrays - Whether to expand array indices (default: false)
 * @returns A flat record with dot-path keys
 *
 * @example
 * ```ts
 * toPlainObject({ a: { b: 1 } }); // { 'a.b': 1 }
 * ```
 */
export function toPlainObject(
  bean: object,
  prefix = '',
  options?: { maxDepth?: number; expandArrays?: boolean },
): Record<string, unknown> {
  const maxDepth = options?.maxDepth ?? 10;
  const expandArrays = options?.expandArrays ?? false;
  const result: Record<string, unknown> = {};

  function flatten(obj: object, currentPrefix: string, depth: number): void {
    if (depth > maxDepth) return;

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = currentPrefix ? `${currentPrefix}.${key}` : key;
      if (value === null || value === undefined) {
        result[fullKey] = value;
      } else if (expandArrays && Array.isArray(value)) {
        value.forEach((item, index) => {
          const arrayKey = `${fullKey}[${index}]`;
          if (typeof item === 'object' && item !== null && !(item instanceof Date)) {
            flatten(item as object, arrayKey, depth + 1);
          } else {
            result[arrayKey] = item;
          }
        });
      } else if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date)
      ) {
        flatten(value as object, fullKey, depth + 1);
      } else {
        result[fullKey] = value;
      }
    }
  }

  flatten(bean, prefix, 0);
  return result;
}

/**
 * Restore a nested object from a flat dot-path record.
 * Inverse of {@link toPlainObject}.
 * @param flat - The flat record with dot-path keys
 * @returns A nested object
 *
 * @example
 * ```ts
 * fromPlainObject({ 'a.b': 1 }); // { a: { b: 1 } }
 * ```
 */
export function fromPlainObject(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let current: Record<string, unknown> = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }

  return result;
}

/**
 * Pick specified fields from an object.
 * @param source - The source object
 * @param fields - Field names to include
 * @returns A partial object containing only the specified fields
 */
export function pick<T extends object>(source: T, ...fields: (keyof T)[]): Partial<T> {
  const result: Partial<T> = {};
  for (const field of fields) {
    if (field in source) {
      result[field] = source[field];
    }
  }
  return result;
}

/**
 * Omit specified fields from an object.
 * @param source - The source object
 * @param fields - Field names to exclude
 * @returns A partial object with the specified fields removed
 */
export function omit<T extends object>(source: T, ...fields: (keyof T)[]): Partial<T> {
  const fieldSet = new Set<keyof T>(fields);
  const result: Partial<T> = {};
  for (const key of Object.keys(source) as (keyof T)[]) {
    if (!fieldSet.has(key)) {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * 获取对象的指定属性值，支持嵌套路径
 *
 * 通过直接属性访问读取简单键，支持 "a.b.c" 嵌套路径。
 */
export function getProperty(source: object, key: string): unknown {
  if (source == null) return undefined;
  // 简单属性直接访问
  if (!key.includes('.')) {
    return (source as Record<string, unknown>)[key];
  }
  // 嵌套路径遍历
  const parts = key.split('.');
  let current: unknown = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 从交替的键值对数组创建 Map
 *
 * 奇数长度时最后一个元素被忽略（Math.floor 截断）。
 *
 * 例: pairingArrayMap("a", 1, "b", 2) => Map { "a" => 1, "b" => 2 }
 */
export function pairingArrayMap<A>(...array: A[]): Map<A, A> {
  const result = new Map<A, A>();
  const len = Math.floor(array.length / 2);
  for (let i = 0; i < len; i++) {
    result.set(array[i * 2], array[i * 2 + 1]);
  }
  return result;
}

/**
 * 从交替的键值对数组创建自定义容器
 *
 * 这是 pairingArrayMap 的通用版本，允许自定义容器和映射逻辑。
 * 奇数长度时最后一个元素被忽略。
 *
 * @param array - 交替的键值对数组
 * @param supplier - 容器工厂函数
 * @param mapping - 接收 (container, key, value) 的映射函数
 * @returns 填充好的容器
 *
 * @example
 * ```ts
 * // 创建普通对象
 * const obj = pairingArray(
 *   ['name', 'test', 'age', '20'],
 *   () => ({} as Record<string, string>),
 *   (o, k, v) => { o[k] = v; },
 * );
 * // { name: 'test', age: '20' }
 * ```
 */
export function pairingArray<A, T>(
  array: A[],
  supplier: () => T,
  mapping: (container: T, key: A, value: A) => void,
): T {
  const container = supplier();
  const len = Math.floor(array.length / 2);
  for (let i = 0; i < len; i++) {
    mapping(container, array[i * 2], array[i * 2 + 1]);
  }
  return container;
}
