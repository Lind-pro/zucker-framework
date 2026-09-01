/**
 * 异常层次结构
 * 参考: hsweb-framework exception 包
 *
 * 对比 hsweb:
 * - BusinessException 增加 HTTP status 和 i18n code 支持
 * - 增加 TraceSourceException 的 source/operation 追踪能力
 * - 增加 NoStackTrace 子类优化高频异常性能
 */

export class BusinessException extends Error {
  readonly code: string;
  readonly status: number;

  /** i18n 消息 code（参考 hsweb I18nSupportException.i18nCode） */
  readonly i18nCode?: string;
  /** i18n 消息参数 */
  readonly i18nArgs?: unknown[];

  /**
   * 附加详情（参考 hsweb ValidationException.Detail / ResponseMessage.result）
   * 可携带结构化错误信息，由异常过滤器放入响应的 result 字段
   */
  readonly details?: unknown;

  /** 异常源追踪（参考 hsweb TraceSourceException.source） */
  private _source?: unknown;
  /** 操作追踪（参考 hsweb TraceSourceException.operation） */
  private _operation?: string;

  constructor(message: string, code = 'BUSINESS_ERROR', status = 500, details?: unknown) {
    super(message);
    this.name = 'BusinessException';
    this.code = code;
    this.status = status;
    this.details = details;
    // 对齐 hsweb I18nSupportException: this.i18nCode = code (message 同时作为 i18n key)
    this.i18nCode = message;
  }

  /**
   * 设置 i18n 消息参数
   * 参考 hsweb I18nSupportException(String code, Object... args)
   */
  withI18nArgs(...args: unknown[]): this {
    (this as { i18nArgs?: unknown[] }).i18nArgs = args;
    return this;
  }

  /**
   * 获取原始消息（不经过 i18n 解析）
   * 参考 hsweb I18nSupportException.getOriginalMessage()
   */
  get originalMessage(): string {
    return super.message ?? this.i18nCode ?? '';
  }

  /**
   * 设置异常源
   * 参考 hsweb TraceSourceException.withSource
   */
  withSource(source: unknown): this {
    this._source = source;
    return this;
  }

  /**
   * 设置操作和异常源
   * 参考 hsweb TraceSourceException.withSource(operation, source)
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
   * 尝试从错误中获取源（参考 hsweb TraceSourceException.tryGetSource）
   */
  static tryGetSource(err: unknown): unknown {
    if (err instanceof BusinessException) {
      return err._source;
    }
    return undefined;
  }

  /**
   * 尝试从错误中获取操作名（参考 hsweb TraceSourceException.tryGetOperation）
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
   * 对齐 hsweb NotFoundException(String message, Object... args): 默认 message 为 i18n key "error.not_found"
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
 * 对比 hsweb ValidationException:
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
   * 参考 hsweb ValidationException(String message, List<Detail> details)
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
 * 对齐 hsweb 5.x UnAuthorizedException.NoStackTrace (commit 775f8f161)
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
 * 对齐 hsweb 5.x AccessDenyException.NoStackTrace (commit 2aed8345f)
 *
 * 在高频触发的权限校验场景中（如未认证请求），跳过堆栈收集以提升性能。
 * hsweb 5.x 在 AccessDenyException 中新增了 NoStackTrace 内部类，
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
 * 对比 hsweb: 数据冲突场景（如并发修改、唯一约束冲突）
 */
export class ConflictException extends BusinessException {
  constructor(message = '数据冲突') {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictException';
  }
}

/**
 * 超时异常 (HTTP 504)
 * 对比 hsweb CommonErrorControllerAdvice.handleException(TimeoutException)
 */
export class TimeoutException extends BusinessException {
  constructor(message = '请求超时') {
    super(message, 'TIMEOUT', 504);
    this.name = 'TimeoutException';
  }
}

/**
 * 不填充线程栈的异常工厂 — 对齐 hsweb 5.x NoStackTrace 模式
 *
 * hsweb 5.x 在 I18nSupportException, BusinessException, AccessDenyException,
 * NotFoundException, ValidationException 等多个异常类中增加了 NoStackTrace 内部类。
 * 其核心设计：在高频异常路径（如未认证请求、参数校验失败等对 stack trace 不敏感的场景）
 * 跳过 fillInStackTrace() 以提升性能。
 *
 * TypeScript/V8 等价方案：通过 Error.captureStackTrace 控制或直接清空 stack，
 * 避免 V8 在高频抛出路径上收集完整调用栈的开销。
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
 * 列名合法性校验 — 对齐 hsweb 5.x QueryHelperUtils.assertLegalColumn
 *
 * 仅允许字母、数字、下划线和 $ 符号，防止 SQL 注入。
 * hsweb 5.x 在 QueryHelperUtils 中新增此方法，用于动态查询场景下
 * 对用户传入的列名进行安全校验。
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
