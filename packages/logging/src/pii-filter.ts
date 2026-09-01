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
  /** 单个字符串的最大日志长度，默认 16 KiB */
  maxStringLength?: number;
  /** 最大递归深度，默认 12 */
  maxDepth?: number;
  /** 单个数组最多保留的元素数，默认 100 */
  maxArrayLength?: number;
  /** 单个对象最多保留的字段数，默认 200 */
  maxObjectKeys?: number;
}

/** 内置 PII 检测模式 */
const BUILTIN_PATTERNS: PiiPattern[] = [
  {
    type: 'url_password',
    regex: /((?:postgres(?:ql)?|redis|rediss|https?):\/\/[^:\s/@]+:)[^@\s/]+@/gi,
    replacement: '$1[REDACTED]@',
  },
  { type: 'email', regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: '[EMAIL]' },
  { type: 'phone_cn', regex: /1[3-9]\d{9}/g, replacement: '[PHONE]' },
  { type: 'idcard_cn', regex: /\d{17}[\dXx]/g, replacement: '[IDCARD]' },
  { type: 'credit_card', regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, replacement: '[CARD]' },
  { type: 'ip_v4', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
  {
    type: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT]',
  },
  { type: 'bearer', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: 'Bearer [REDACTED]' },
  { type: 'basic_auth', regex: /\bBasic\s+[A-Za-z0-9+/=]+/gi, replacement: 'Basic [REDACTED]' },
  {
    type: 'secret_parameter',
    regex:
      /((?:password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|x-amz-signature|x-amz-credential)=)[^&\s]+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    type: 'aws_access_key',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: '[AWS_ACCESS_KEY]',
  },
  {
    type: 'private_key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[PRIVATE_KEY]',
  },
];

/** 内置敏感字段名 */
const BUILTIN_SENSITIVE_FIELDS = new Set([
  'password',
  'passwd',
  'passwordhash',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'uploadtoken',
  'uploadtokenhash',
  'authorization',
  'cookie',
  'setcookie',
  'xuploadtoken',
  'apikey',
  'privatekey',
  'databaseurl',
  'connectionstring',
  'creditcard',
  'ssn',
  'idcard',
]);

export class PiiFilter {
  private readonly patterns: PiiPattern[];
  private readonly sensitiveFields: Set<string>;
  private readonly allowedFields: Set<string>;
  private readonly maxStringLength: number;
  private readonly maxDepth: number;
  private readonly maxArrayLength: number;
  private readonly maxObjectKeys: number;

  constructor(options: PiiFilterOptions = {}) {
    this.patterns = [...BUILTIN_PATTERNS, ...(options.patterns ?? [])];
    this.sensitiveFields = new Set(
      [...BUILTIN_SENSITIVE_FIELDS, ...(options.sensitiveFields ?? [])].map(normalizeFieldName),
    );
    this.allowedFields = new Set((options.allowedFields ?? []).map(normalizeFieldName));
    this.maxStringLength = Math.max(256, options.maxStringLength ?? 16_384);
    this.maxDepth = Math.max(1, options.maxDepth ?? 12);
    this.maxArrayLength = Math.max(1, options.maxArrayLength ?? 100);
    this.maxObjectKeys = Math.max(1, options.maxObjectKeys ?? 200);
  }

  /**
   * 对字符串进行 PII 脱敏
   */
  sanitize(text: string): string {
    let result =
      text.length > this.maxStringLength
        ? `${text.slice(0, this.maxStringLength)}[TRUNCATED]`
        : text;
    for (const pattern of this.patterns) {
      pattern.regex.lastIndex = 0;
      result = result.replace(pattern.regex, pattern.replacement);
    }
    return result;
  }

  /**
   * 对对象进行深度 PII 脱敏
   */
  sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
    return this.sanitizeValue(obj) as T;
  }

  sanitizeValue(value: unknown): unknown {
    return this.sanitizeDeep(value, '', 0, new WeakSet<object>());
  }

  private sanitizeDeep(
    value: unknown,
    fieldName: string,
    depth: number,
    seen: WeakSet<object>,
  ): unknown {
    if (value === null || value === undefined) return value;

    // 白名单字段跳过
    if (this.allowedFields.has(normalizeFieldName(fieldName))) return value;

    // 敏感字段直接替换
    if (this.sensitiveFields.has(normalizeFieldName(fieldName))) {
      return '[REDACTED]';
    }

    if (typeof value === 'string') {
      return this.sanitize(value);
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (depth >= this.maxDepth) {
      return '[MAX_DEPTH]';
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof Error) {
      return {
        name: this.sanitize(value.name),
        message: this.sanitize(value.message),
        stack: value.stack ? this.sanitize(value.stack) : undefined,
      };
    }

    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
      const sanitized = value
        .slice(0, this.maxArrayLength)
        .map((item) => this.sanitizeDeep(item, fieldName, depth + 1, seen));
      if (value.length > this.maxArrayLength) {
        sanitized.push(`[TRUNCATED ${value.length - this.maxArrayLength} ITEMS]`);
      }
      return sanitized;
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, val] of entries.slice(0, this.maxObjectKeys)) {
      result[key] = this.sanitizeDeep(val, key, depth + 1, seen);
    }
    if (entries.length > this.maxObjectKeys) {
      result.__truncated__ = `${entries.length - this.maxObjectKeys} fields omitted`;
    }

    return result;
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

function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[^a-z0-9]/g, '');
}
