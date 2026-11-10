/**
 * PII (个人可识别信息) 过滤器 — 对标 Claude Code analytics 的 PII 标记类型
 *
 * 自动识别和脱敏日志中的敏感信息（邮箱、手机号、身份证号等）。
 *
 * 字段名匹配: 规范化（小写、去除标点）后精确匹配内置/自定义名单，并对 password/secret/apikey/
 * authorization/cookie/credential 等片段做包含匹配、对 token/otp/signature/...code 等做后缀匹配，
 * 因此 `newPassword`、`x-api-key`、`idToken`、`smsCode` 都会被脱敏，而 `maxTokens`、`statusCode` 不会。
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
  /** 一次 sanitizeValue 中所有字符串的总长度上限，默认 256 KiB；超出部分替换为 [TRUNCATED] */
  maxTotalStringLength?: number;
  /** 最大递归深度，默认 12 */
  maxDepth?: number;
  /** 单个数组最多保留的元素数，默认 100 */
  maxArrayLength?: number;
  /** 单个对象最多保留的字段数，默认 200 */
  maxObjectKeys?: number;
}

/*
 * Every built-in pattern must stay linear in the input length: every repetition is bounded, and
 * patterns whose prefix is a long character class start only where the previous character cannot
 * extend the token (lookbehind). Unbounded `[\w.]+@...` style patterns rescan to the end of a long token from each
 * start position, which made a single 16 KiB value cost ~0.5 s per pass.
 */
const BUILTIN_PATTERNS: PiiPattern[] = [
  {
    type: 'url_password',
    regex: /((?:postgres(?:ql)?|redis|rediss|https?|amqps?|mongodb(?:\+srv)?|mysql):\/\/[^:\s/@]{1,256}:)[^@\s/]{1,1024}@/gi,
    replacement: '$1[REDACTED]@',
  },
  { type: 'phone_cn', regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replacement: '[PHONE]' },
  { type: 'idcard_cn', regex: /(?<!\d)\d{17}[\dXx](?![\dXx])/g, replacement: '[IDCARD]' },
  { type: 'credit_card', regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, replacement: '[CARD]' },
  { type: 'ip_v4', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
  {
    type: 'jwt',
    regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{1,8192}\.eyJ[A-Za-z0-9_-]{1,16384}\.[A-Za-z0-9_-]{0,8192}/g,
    replacement: '[JWT]',
  },
  { type: 'bearer', regex: /\bBearer\s{1,16}[A-Za-z0-9._~+/=-]{1,8192}/gi, replacement: 'Bearer [REDACTED]' },
  { type: 'basic_auth', regex: /\bBasic\s{1,16}[A-Za-z0-9+/=]{1,8192}/gi, replacement: 'Basic [REDACTED]' },
  {
    type: 'secret_parameter',
    regex:
      /((?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|otp|x-amz-signature|x-amz-credential|x-amz-security-token|signature|sig)=)[^&\s]{1,8192}/gi,
    replacement: '$1[REDACTED]',
  },
  {
    // Provider API keys (OpenAI/Anthropic style, GitHub, Google, Slack, Stripe).
    type: 'api_key',
    regex:
      /(?<![A-Za-z0-9_-])(?:sk-(?:proj-|ant-|live_|test_)?[A-Za-z0-9_-]{20,512}|gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,255}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,255})/g,
    replacement: '[API_KEY]',
  },
  {
    type: 'aws_access_key',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: '[AWS_ACCESS_KEY]',
  },
];

/** Exact normalized field names that are always redacted. */
const BUILTIN_SENSITIVE_FIELDS = new Set([
  'password',
  'passwd',
  'passwordhash',
  'pwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'uploadtoken',
  'uploadtokenhash',
  'tokenhash',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xuploadtoken',
  'apikey',
  'privatekey',
  'databaseurl',
  'connectionstring',
  'dsn',
  'creditcard',
  'cardnumber',
  'cvv',
  'cvc',
  'pin',
  'otp',
  'totp',
  'captcha',
  'ssn',
  'idcard',
  'sessionid',
  'sid',
]);

/**
 * Normalized name fragments that mark a field as sensitive wherever they appear
 * (`newPassword`, `x-api-key`, `secretAccessKey`, `X-CSRF-Token`, ...).
 * Only fragments that are unambiguous are listed; `token`/`key`/`code` are suffix rules below
 * so that `maxTokens`, `keyword` or `statusCode` stay readable.
 */
const SENSITIVE_FIELD_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'accesskey',
  'signingkey',
  'encryptionkey',
  'captcha',
  'csrf',
  'xsrf',
];

/** Normalized suffixes that mark a field as sensitive (`idToken`, `xAuthToken`, `smsCode`). */
const SENSITIVE_FIELD_SUFFIXES = [
  'token',
  'tokenhash',
  'pwd',
  'otp',
  'totp',
  'signature',
  'sessionid',
  'sessionkey',
  'secretkey',
  'masterkey',
  'licensekey',
  'verificationcode',
  'verifycode',
  'authcode',
  'otpcode',
  'smscode',
  'emailcode',
  'mfacode',
  'resetcode',
  'securitycode',
  'logincode',
  'pincode',
];

/** Additional fragments applied to HTTP header names only; header names are a closed vocabulary. */
const SENSITIVE_HEADER_FRAGMENTS = ['auth', 'token', 'secret', 'key', 'cookie', 'signature', 'session', 'credential', 'csrf', 'xsrf'];

// Emails are matched around each '@' (see redactEmails) instead of with a free-standing regex:
// a `[\w.+-]{1,64}@` prefix costs up to 64 steps at every position of any long word.
const EMAIL_LOCAL_CHAR = /[\w.+-]/;
const EMAIL_DOMAIN = /[\w-]{1,253}(?:\.[\w-]{1,63}){1,8}/y;
const EMAIL_LOCAL_MAX = 64;

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z ]{0,64}PRIVATE KEY-----/g;

/** Default total string budget for one sanitizeValue call (all strings combined). */
const DEFAULT_MAX_TOTAL_STRING_LENGTH = 256 * 1024;

export class PiiFilter {
  private readonly options: PiiFilterOptions;
  private readonly patterns: PiiPattern[];
  private readonly sensitiveFields: Set<string>;
  private readonly allowedFields: Set<string>;
  private readonly maxStringLength: number;
  private readonly maxTotalStringLength: number;
  private readonly maxDepth: number;
  private readonly maxArrayLength: number;
  private readonly maxObjectKeys: number;

  constructor(options: PiiFilterOptions = {}) {
    this.options = options;
    this.patterns = [...BUILTIN_PATTERNS, ...(options.patterns ?? [])];
    this.sensitiveFields = new Set(
      [...BUILTIN_SENSITIVE_FIELDS, ...(options.sensitiveFields ?? [])].map(normalizeFieldName),
    );
    this.allowedFields = new Set((options.allowedFields ?? []).map(normalizeFieldName));
    this.maxStringLength = Math.max(256, options.maxStringLength ?? 16_384);
    this.maxTotalStringLength = Math.max(
      this.maxStringLength,
      options.maxTotalStringLength ?? DEFAULT_MAX_TOTAL_STRING_LENGTH,
    );
    this.maxDepth = Math.max(1, options.maxDepth ?? 12);
    this.maxArrayLength = Math.max(1, options.maxArrayLength ?? 100);
    this.maxObjectKeys = Math.max(1, options.maxObjectKeys ?? 200);
  }

  /** A filter with this filter's configuration plus extra options (lists are merged). */
  extend(options: PiiFilterOptions): PiiFilter {
    return new PiiFilter({
      ...this.options,
      ...options,
      patterns: [...(this.options.patterns ?? []), ...(options.patterns ?? [])],
      sensitiveFields: [...(this.options.sensitiveFields ?? []), ...(options.sensitiveFields ?? [])],
      allowedFields: [...(this.options.allowedFields ?? []), ...(options.allowedFields ?? [])],
    });
  }

  /**
   * 对字符串进行 PII 脱敏
   */
  sanitize(text: string): string {
    let result =
      text.length > this.maxStringLength
        ? `${text.slice(0, this.maxStringLength)}[TRUNCATED]`
        : text;
    result = redactPrivateKeys(result);
    for (let index = 0; index < this.patterns.length; index += 1) {
      const pattern = this.patterns[index];
      pattern.regex.lastIndex = 0;
      result = result.replace(pattern.regex, pattern.replacement);
      // Same order as before: URL credentials first, then emails, then the other patterns.
      if (index === 0) result = redactEmails(result);
    }
    return result;
  }

  /** True when the field name (property, header or parameter) always holds a secret. */
  isSensitiveField(fieldName: string): boolean {
    const normalized = normalizeFieldName(fieldName);
    if (!normalized || this.allowedFields.has(normalized)) return false;
    return isSensitiveNormalizedName(normalized, this.sensitiveFields);
  }

  /**
   * Redacts HTTP headers. Header names are a closed vocabulary, so any name mentioning
   * auth/token/secret/key/cookie/signature/session/credential is treated as a credential.
   */
  sanitizeHeaders(
    headers: Record<string, string | string[] | undefined> | undefined,
  ): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};
    if (!headers) return result;
    let kept = 0;
    for (const [name, raw] of Object.entries(headers)) {
      if (kept++ >= this.maxObjectKeys) break;
      const normalized = normalizeFieldName(name);
      if (this.allowedFields.has(normalized)) {
        result[name] = Array.isArray(raw) ? raw.join(', ') : raw;
        continue;
      }
      if (
        isSensitiveNormalizedName(normalized, this.sensitiveFields) ||
        SENSITIVE_HEADER_FRAGMENTS.some((fragment) => normalized.includes(fragment))
      ) {
        result[name] = raw === undefined ? undefined : '[REDACTED]';
        continue;
      }
      const value = Array.isArray(raw) ? raw.join(', ') : raw;
      result[name] = value === undefined ? undefined : this.sanitize(String(value));
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
    return this.sanitizeDeep(value, '', 0, {
      seen: new WeakSet<object>(),
      remaining: this.maxTotalStringLength,
    });
  }

  private sanitizeDeep(
    value: unknown,
    fieldName: string,
    depth: number,
    state: SanitizeState,
  ): unknown {
    if (value === null || value === undefined) return value;

    const normalized = normalizeFieldName(fieldName);
    // 白名单字段跳过
    if (normalized && this.allowedFields.has(normalized)) return value;

    // 敏感字段直接替换
    if (normalized && isSensitiveNormalizedName(normalized, this.sensitiveFields)) {
      return '[REDACTED]';
    }

    if (typeof value === 'string') {
      return this.sanitizeBudgeted(value, state);
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
        name: this.sanitizeBudgeted(value.name, state),
        message: this.sanitizeBudgeted(value.message, state),
        stack: value.stack ? this.sanitizeBudgeted(value.stack, state) : undefined,
      };
    }

    if (state.seen.has(value)) {
      return '[CIRCULAR]';
    }
    state.seen.add(value);

    if (Array.isArray(value)) {
      const sanitized = value
        .slice(0, this.maxArrayLength)
        .map((item) => this.sanitizeDeep(item, fieldName, depth + 1, state));
      if (value.length > this.maxArrayLength) {
        sanitized.push(`[TRUNCATED ${value.length - this.maxArrayLength} ITEMS]`);
      }
      return sanitized;
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, val] of entries.slice(0, this.maxObjectKeys)) {
      result[key] = this.sanitizeDeep(val, key, depth + 1, state);
    }
    if (entries.length > this.maxObjectKeys) {
      result.__truncated__ = `${entries.length - this.maxObjectKeys} fields omitted`;
    }

    return result;
  }

  /** Bounds the total pattern work per record, not only per string. */
  private sanitizeBudgeted(value: string, state: SanitizeState): string {
    if (state.remaining <= 0) return '[TRUNCATED]';
    const limit = Math.min(this.maxStringLength, state.remaining);
    state.remaining -= Math.min(value.length, limit);
    if (value.length > limit) {
      return `${this.sanitize(value.slice(0, limit))}[TRUNCATED]`;
    }
    return this.sanitize(value);
  }

  /**
   * 检查字符串中是否包含 PII
   */
  containsPii(text: string): boolean {
    const bounded = text.length > this.maxStringLength ? text.slice(0, this.maxStringLength) : text;
    if (redactPrivateKeys(bounded) !== bounded || redactEmails(bounded) !== bounded) return true;
    return this.patterns.some((p) => {
      p.regex.lastIndex = 0; // reset for global regex
      return p.regex.test(bounded);
    });
  }
}

interface SanitizeState {
  seen: WeakSet<object>;
  remaining: number;
}

function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveNormalizedName(normalized: string, exact: ReadonlySet<string>): boolean {
  if (exact.has(normalized)) return true;
  for (const fragment of SENSITIVE_FIELD_FRAGMENTS) {
    if (normalized.includes(fragment)) return true;
  }
  for (const suffix of SENSITIVE_FIELD_SUFFIXES) {
    if (normalized.endsWith(suffix)) return true;
  }
  return false;
}

/** Linear private-key block redaction (a lazy `[\s\S]*?` regex rescans for every unmatched BEGIN). */
function redactPrivateKeys(text: string): string {
  if (!text.includes('PRIVATE KEY-----')) return text;
  let output = '';
  let cursor = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  PRIVATE_KEY_END.lastIndex = 0;
  let begin: RegExpExecArray | null;
  let endSearchFrom = 0;
  let endExhausted = false;
  while ((begin = PRIVATE_KEY_BEGIN.exec(text)) !== null) {
    if (endExhausted) break;
    PRIVATE_KEY_END.lastIndex = Math.max(endSearchFrom, begin.index + begin[0].length);
    const end = PRIVATE_KEY_END.exec(text);
    if (!end) {
      endExhausted = true;
      break;
    }
    output += `${text.slice(cursor, begin.index)}[PRIVATE_KEY]`;
    cursor = end.index + end[0].length;
    endSearchFrom = cursor;
    PRIVATE_KEY_BEGIN.lastIndex = cursor;
  }
  return output + text.slice(cursor);
}

/** Linear email redaction: each '@' expands at most 64 characters left and a bounded domain right. */
function redactEmails(text: string): string {
  let at = text.indexOf('@');
  if (at < 0) return text;
  let output = '';
  let cursor = 0;
  while (at >= 0) {
    let start = at;
    const floor = Math.max(cursor, at - EMAIL_LOCAL_MAX);
    while (start > floor && EMAIL_LOCAL_CHAR.test(text[start - 1])) start -= 1;
    EMAIL_DOMAIN.lastIndex = at + 1;
    const domain = start < at ? EMAIL_DOMAIN.exec(text) : null;
    if (domain) {
      output += `${text.slice(cursor, start)}[EMAIL]`;
      cursor = at + 1 + domain[0].length;
      at = text.indexOf('@', cursor);
    } else {
      at = text.indexOf('@', at + 1);
    }
  }
  return output + text.slice(cursor);
}
