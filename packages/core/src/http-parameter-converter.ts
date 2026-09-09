/**
 * HttpParameterConverter — 对象转 HTTP 查询参数
 *
 * 将嵌套的对象/数组结构扁平化为 HTTP 查询参数的 key=value 格式。
 * 支持嵌套对象（用 "." 分隔）和数组（用 "[index]" 表示）。
 *
 * @example
 * ```ts
 * toHttpParameters({ name: 'test', tags: ['a', 'b'], nested: { id: 1 } })
 * // { 'name': 'test', 'tags[0]': 'a', 'tags[1]': 'b', 'nested.id': '1' }
 * ```
 */

/**
 * 将对象转换为扁平的 HTTP 查询参数映射
 *
 * @param bean - 待转换的对象
 * @param prefix - 参数名前缀（默认为空）
 * @returns 扁平化的 key-value 映射
 */
export function toHttpParameters(
  bean: Record<string, unknown>,
  prefix = '',
): Record<string, string> {
  const result: Record<string, string> = {};
  doConvert(bean, prefix, result);
  return result;
}

function getParameterKey(prefix: string, key: string): string {
  return prefix ? `${prefix}${key}` : key;
}

function doConvert(
  obj: Record<string, unknown>,
  prefix: string,
  result: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    convertValue(getParameterKey(prefix, key), value, result);
  }
}

function convertValue(
  key: string,
  value: unknown,
  result: Record<string, string>,
): void {
  if (value === null || value === undefined) {
    return;
  }

  // 基本类型直接转字符串
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    result[key] = String(value);
    return;
  }

  // Date 格式化
  if (value instanceof Date) {
    result[key] = value.toISOString();
    return;
  }

  // 数组展开
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      convertValue(`${key}[${i}]`, value[i], result);
    }
    return;
  }

  // 嵌套对象递归
  if (typeof value === 'object') {
    doConvert(value as Record<string, unknown>, `${key}.`, result);
  }
}

/**
 * 将扁平的 HTTP 查询参数映射还原为嵌套对象
 * 这是 toHttpParameters 的逆操作
 *
 * @param params - 扁平化的 key-value 映射
 * @returns 还原后的嵌套对象
 */
export function fromHttpParameters(
  params: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    setNestedValue(result, key, value);
  }

  return result;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: string,
): void {
  // 解析路径: "a.b[0].c" => ["a", "b", "[0]", "c"]
  const parts = path.split(/\./).flatMap((part) => {
    const result: string[] = [];
    let current = part;
    while (current.includes('[')) {
      const bracketStart = current.indexOf('[');
      const bracketEnd = current.indexOf(']');
      if (bracketStart > 0) {
        result.push(current.substring(0, bracketStart));
      }
      result.push(current.substring(bracketStart + 1, bracketEnd));
      current = current.substring(bracketEnd + 1);
    }
    if (current) {
      result.push(current);
    }
    return result.length > 0 ? result : [part];
  });

  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const isNextArray = /^\d+$/.test(nextPart);

    if (!(part in current)) {
      current[part] = isNextArray ? [] : {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}
