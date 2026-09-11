/**
 * 文本卫生：剥离 PostgreSQL 不接受的 NUL 字符 (0x00)。
 *
 * Postgres 的 text / jsonb 列不允许存储 0x00 字符，AI 模型输出偶发包含该字符，
 * 直接落库会抛 "invalid byte sequence for encoding UTF8: 0x00" / "unsupported
 * Unicode escape sequence" 并导致整次生成保存失败。此处仅剥离 0x00，
 * 保留 \n \t 等合法控制字符，最小侵入。
 */
const NULL_CHAR = String.fromCharCode(0);

export function stripNullBytes(value: string): string {
  return value.includes(NULL_CHAR) ? value.split(NULL_CHAR).join('') : value;
}

/**
 * 递归剥离对象 / 数组中所有字符串值的 NUL 字符（原地修改，调用方需拥有该对象）。
 * 用于结构化 AI 输出落库前的兜底清洗。
 */
export function deepStripNullBytes<T>(value: T): T {
  if (typeof value === 'string') {
    return stripNullBytes(value) as T;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = deepStripNullBytes(value[i]);
    }
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = deepStripNullBytes(record[key]);
    }
    return value;
  }
  return value;
}
