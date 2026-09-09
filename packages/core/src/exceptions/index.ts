/**
 * 异常层次结构
 *
 * - BusinessException 支持 HTTP status 和 i18n code
 * - 通过 source/operation 记录异常来源和操作
 * - 提供仅保留异常名称和消息的 stack 格式
 */

export class BusinessException extends Error {
  readonly code: string;
  readonly status: number;

  /** i18n 消息 code */
  readonly i18nCode?: string;
  /** i18n 消息参数 */
  readonly i18nArgs?: unknown[];

  /**
   * 附加详情
   * 可携带结构化错误信息，由异常过滤器放入响应的 result 字段
   */
  readonly details?: unknown;

  /** 异常源追踪 */
  private _source?: unknown;
  /** 操作追踪 */
  private _operation?: string;

  constructor(message: string, code = 'BUSINESS_ERROR', status = 500, details?: unknown) {
    super(message);
    this.name = 'BusinessException';
    this.code = code;
    this.status = status;
    this.details = details;
    // message 同时作为默认 i18n key
    this.i18nCode = message;
  }

  /**
   * 设置 i18n 消息参数
   */
  withI18nArgs(...args: unknown[]): this {
    (this as { i18nArgs?: unknown[] }).i18nArgs = args;
    return this;
  }

  /**
   * 获取原始消息（不经过 i18n 解析）
   */
  get originalMessage(): string {
    return super.message ?? this.i18nCode ?? '';
  }

  /**
   * 设置异常源
   */
  withSource(source: unknown): this {
    this._source = source;
    return this;
  }

  /**
   * 设置操作和异常源
   */
  withOperation(operation: string, source?: unknown): this {
    this._operation = operation;
    if (source !== undefined) {
      this._source = source;
    }
    return this;
  }

  get source(): unknown {
    return this._source;
  }

  get operation(): string | undefined {
    return this._operation;
  }

  /**
   * 尝试从错误中获取源
   */
  static tryGetSource(err: unknown): unknown {
    if (err instanceof BusinessException) {
      return err._source;
    }
    return undefined;
  }

  /**
   * 尝试从错误中获取操作名
   */
  static tryGetOperation(err: unknown): string | undefined {
    if (err instanceof BusinessException) {
      return err._operation;
    }
    return undefined;
  }
}

export class NotFoundException extends BusinessException {
  /**
   * @param message i18n message key 或直接消息
   * @param args i18n 消息参数
   * 默认 message 为 i18n key "error.not_found"
   */
  constructor(message = 'error.not_found', ...args: unknown[]) {
    super(message, 'NOT_FOUND', 404);
    this.name = 'NotFoundException';
    if (args.length > 0) {
      this.withI18nArgs(...args);
    }
  }
}

/**
 * 验证异常
 *
 * - 增加 details 列表支持（property + message + detail 三元组）
 * - 保留原有的 errors Record 格式以保持向后兼容
 */
export interface ValidationDetail {
  property: string;
  message: string;
  detail?: unknown;
}

export class ValidationException extends BusinessException {
  readonly errors: Record<string, string[]>;
  readonly details: ValidationDetail[];

  constructor(
    errors: Record<string, string[]>,
    message = 'validation.property_validate_failed',
  ) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationException';
    this.errors = errors;
    // 将 errors Record 转换为 details 列表
    this.details = [];
    for (const [property, messages] of Object.entries(errors)) {
      for (const msg of messages) {
        this.details.push({ property, message: msg });
      }
    }
  }

  /**
   * 从 details 列表创建
   */
  static fromDetails(details: ValidationDetail[], message = 'validation.property_validate_failed'): ValidationException {
    const errors: Record<string, string[]> = {};
    for (const detail of details) {
      if (!errors[detail.property]) {
        errors[detail.property] = [];
      }
      errors[detail.property].push(detail.message);
    }
    const exception = new ValidationException(errors, message);
    // Overwrite with original details to preserve 'detail' field
    (exception as { details: ValidationDetail[] }).details = details;
    return exception;
  }
}

export class UnauthorizedException extends BusinessException {
  constructor(message = '未授权') {
    super(message, 'UNAUTHORIZED', 401);
    this.name = 'UnauthorizedException';
  }
}

/**
 * 未授权异常 — 不捕获调用栈
 *
 * 每个未认证请求都会触发此异常，属于高频路径，
 * 跳过堆栈收集可显著降低 GC 压力。
 */
export class UnauthorizedNoStackTrace extends UnauthorizedException {
  constructor(message = '未授权') {
    super(message);
    this.name = 'UnauthorizedException';
    this.stack = `${this.name}: ${this.message}`;
  }
}

export class ForbiddenException extends BusinessException {
  constructor(message = '禁止访问') {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenException';
  }
}

/**
 * 访问拒绝异常 (HTTP 403) — 不捕获调用栈
 *
 * 在高频触发的权限校验场景中（如未认证请求），跳过堆栈收集以提升性能。
 * 用于不需要调试信息的拒绝响应。
 */
export class ForbiddenNoStackTrace extends ForbiddenException {
  constructor(message = '禁止访问') {
    super(message);
    this.name = 'ForbiddenException';
    this.stack = `${this.name}: ${this.message}`;
  }
}

export class OperationCancelledException extends BusinessException {
  constructor(reason?: string) {
    super(reason ?? '操作已被取消', 'OPERATION_CANCELLED', 400);
    this.name = 'OperationCancelledException';
  }
}

/**
 * 冲突异常 (HTTP 409)
 * 用于数据冲突场景（如并发修改、唯一约束冲突）
 */
export class ConflictException extends BusinessException {
  constructor(message = '数据冲突') {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictException';
  }
}

/**
 * 超时异常 (HTTP 504)
 */
export class TimeoutException extends BusinessException {
  constructor(message = '请求超时') {
    super(message, 'TIMEOUT', 504);
    this.name = 'TimeoutException';
  }
}

/**
 * 不填充线程栈的异常工厂
 *
 * 在不需要完整调试信息的高频异常路径中，将 stack 替换为异常名称和消息。
 *
 * @example
 * ```ts
 * // 高频校验场景
 * throw noStack(new ValidationException({ name: ['不能为空'] }));
 *
 * // 未授权请求（每个请求都可能触发）
 * throw noStack(new UnauthorizedException());
 *
 * // 带自定义消息
 * throw noStack(new NotFoundException('用户不存在'));
 * ```
 */
export function noStack<T extends Error>(error: T): T {
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

/**
 * 列名合法性校验
 *
 * 仅允许字母、数字、下划线和 $ 符号，防止 SQL 注入。
 * 用于动态查询场景下对用户传入的列名进行安全校验。
 */
export function assertLegalColumn(col: string): void {
  if (!isLegalColumn(col)) {
    throw noStack(new BusinessException(
      `非法列名: ${col}`,
      'ILLEGAL_COLUMN_NAME',
      400,
    ));
  }
}

export function isLegalColumn(col: string): boolean {
  for (let i = 0; i < col.length; i++) {
    const c = col.charCodeAt(i);
    // a-z, A-Z, 0-9, _, $
    if (
      (c >= 97 && c <= 122) || // a-z
      (c >= 65 && c <= 90) ||  // A-Z
      (c >= 48 && c <= 57) ||  // 0-9
      c === 95 ||              // _
      c === 36                 // $
    ) {
      continue;
    }
    return false;
  }
  return col.length > 0;
}
