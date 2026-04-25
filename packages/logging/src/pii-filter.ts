/**
 * PII (个人可识别信息) 过滤器 — 对标 Claude Code analytics 的 PII 标记类型
 *
 * 自动识别和脱敏日志中的敏感信息（邮箱、手机号、身份证号等）。
 *
 * 用法:
 * ```ts
 * const filter = new PiiFilter();
 * const safe = filter.sanitize('用户邮箱是 test@example.com，手机 13800138000');
 * // → '用户邮箱是 [EMAIL]，手机 [PHONE]'
 *
 * const safeObj = filter.sanitizeObject({ name: '张三', email: 'test@example.com', token: 'abc123' });
 * // → { name: '张三', email: '[EMAIL]', token: '[REDACTED]' }
 * ```
 */

export interface PiiPattern {
  type: string;
  regex: RegExp;
  replacement: string;
}

export interface PiiFilterOptions {
  /** 自定义匹配模式（追加到内置模式之后） */
  patterns?: PiiPattern[];
  /** 字段名黑名单（这些字段的值总是被替换为 [REDACTED]） */
  sensitiveFields?: string[];
  /** 字段名白名单（这些字段跳过过滤，即使内容匹配 PII 模式） */
  allowedFields?: string[];
}

/** 内置 PII 检测模式 */
const BUILTIN_PATTERNS: PiiPattern[] = [
  { type: 'email', regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: '[EMAIL]' },
  { type: 'phone_cn', regex: /1[3-9]\d{9}/g, replacement: '[PHONE]' },
  { type: 'idcard_cn', regex: /\d{17}[\dXx]/g, replacement: '[IDCARD]' },
  { type: 'credit_card', regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, replacement: '[CARD]' },
  { type: 'ip_v4', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
  { type: 'jwt', regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: '[JWT]' },
];

/** 内置敏感字段名 */
const BUILTIN_SENSITIVE_FIELDS = new Set([
  'password', 'passwd', 'secret', 'token', 'accessToken', 'refreshToken',
  'access_token', 'refresh_token', 'apiKey', 'api_key', 'authorization',
  'creditCard', 'credit_card', 'ssn', 'idcard', 'id_card',
]);

export class PiiFilter {
  private readonly patterns: PiiPattern[];
  private readonly sensitiveFields: Set<string>;
  private readonly allowedFields: Set<string>;

  constructor(options: PiiFilterOptions = {}) {
    this.patterns = [...BUILTIN_PATTERNS, ...(options.patterns ?? [])];
    this.sensitiveFields = new Set(
      [...BUILTIN_SENSITIVE_FIELDS, ...(options.sensitiveFields ?? [])].map(f => f.toLowerCase()),
    );
    this.allowedFields = new Set(options.allowedFields ?? []);
  }

  /**
   * 对字符串进行 PII 脱敏
   */
  sanitize(text: string): string {
    let result = text;
    for (const pattern of this.patterns) {
      result = result.replace(pattern.regex, pattern.replacement);
    }
    return result;
  }

  /**
   * 对对象进行深度 PII 脱敏
   */
  sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
    return this.sanitizeDeep(obj, '') as T;
  }

  private sanitizeDeep(value: unknown, fieldName: string): unknown {
    if (value === null || value === undefined) return value;

    // 白名单字段跳过
    if (this.allowedFields.has(fieldName)) return value;

    // 敏感字段直接替换
    if (this.sensitiveFields.has(fieldName.toLowerCase())) {
      return '[REDACTED]';
    }

    if (typeof value === 'string') {
      return this.sanitize(value);
    }

    if (Array.isArray(value)) {
      return value.map((item, i) => this.sanitizeDeep(item, fieldName));
    }

    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.sanitizeDeep(val, key);
      }
      return result;
    }

    return value;
  }

  /**
   * 检查字符串中是否包含 PII
   */
  containsPii(text: string): boolean {
    return this.patterns.some((p) => {
      p.regex.lastIndex = 0; // reset for global regex
      return p.regex.test(text);
    });
  }
}
