import { BusinessException, NotFoundException, ConflictException, TimeoutException } from './exceptions';

/**
 * 错误分类结果
 *
 * 对标 Claude Code 的 categorizeRetryableAPIError():
 * 对每个错误做结构化分类——可重试/不可重试/需特殊处理。
 */
export interface ErrorClassification {
  /** 该错误是否可以安全重试 */
  retryable: boolean;
  /** 标准化的错误代码 */
  code: string;
  /** 对应的 HTTP 状态码 */
  status: number;
  /** 人类可读的错误消息 */
  message: string;
  /** 建议的重试延迟（毫秒）。仅当 retryable=true 时有意义 */
  retryAfterMs?: number;
  /** 原始错误 */
  cause: unknown;
}

/**
 * Prisma 错误码映射表
 * @see https://www.prisma.io/docs/reference/api-reference/error-reference
 */
const PRISMA_ERROR_MAP: Record<string, Omit<ErrorClassification, 'cause' | 'message'>> = {
  // 唯一约束冲突
  P2002: { retryable: false, code: 'UNIQUE_CONSTRAINT', status: 409 },
  // 外键约束失败
  P2003: { retryable: false, code: 'FOREIGN_KEY_CONSTRAINT', status: 400 },
  // 记录不存在
  P2025: { retryable: false, code: 'NOT_FOUND', status: 404 },
  // 事务写冲突（可重试）
  P2034: { retryable: true, code: 'TRANSACTION_CONFLICT', status: 409, retryAfterMs: 100 },
  // 值超出范围
  P2006: { retryable: false, code: 'VALUE_OUT_OF_RANGE', status: 400 },
  // 记录存储数据验证失败
  P2007: { retryable: false, code: 'DATA_VALIDATION_ERROR', status: 400 },
  // 查询解析失败
  P2008: { retryable: false, code: 'QUERY_PARSE_ERROR', status: 400 },
  // 查询验证失败
  P2009: { retryable: false, code: 'QUERY_VALIDATION_ERROR', status: 400 },
  // 连接超时（可重试）
  P1008: { retryable: true, code: 'DB_TIMEOUT', status: 504, retryAfterMs: 1000 },
  // 数据库不可达（可重试）
  P1001: { retryable: true, code: 'DB_UNREACHABLE', status: 503, retryAfterMs: 2000 },
  // 连接池已满（可重试）
  P2024: { retryable: true, code: 'POOL_TIMEOUT', status: 503, retryAfterMs: 500 },
};

function getPrismaErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    const code = (error as { code: string }).code;
    if (code.startsWith('P')) return code;
  }
  return undefined;
}

function isTimeoutLike(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout');
  }
  return false;
}

function isConnectionError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('enotfound') ||
      msg.includes('connection') && msg.includes('refused')
    );
  }
  return false;
}

/**
 * 对错误进行结构化分类
 *
 * @example
 * ```ts
 * try {
 *   await db.user.create({ data });
 * } catch (error) {
 *   const cls = classifyError(error);
 *   if (cls.retryable) {
 *     await sleep(cls.retryAfterMs ?? 100);
 *     // retry...
 *   } else {
 *     throw cls.toException();
 *   }
 * }
 * ```
 */
export function classifyError(error: unknown): ErrorClassification {
  // 1. 已经是 BusinessException → 保持原样
  if (error instanceof BusinessException) {
    return {
      retryable: false,
      code: error.code,
      status: error.status,
      message: error.message,
      cause: error,
    };
  }

  // 2. Prisma 错误码匹配
  const prismaCode = getPrismaErrorCode(error);
  if (prismaCode && PRISMA_ERROR_MAP[prismaCode]) {
    const mapping = PRISMA_ERROR_MAP[prismaCode];
    return {
      ...mapping,
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    };
  }

  // 3. 超时检测
  if (isTimeoutLike(error)) {
    return {
      retryable: true,
      code: 'TIMEOUT',
      status: 504,
      message: error instanceof Error ? error.message : 'Operation timed out',
      retryAfterMs: 1000,
      cause: error,
    };
  }

  // 4. 连接错误检测
  if (isConnectionError(error)) {
    return {
      retryable: true,
      code: 'CONNECTION_ERROR',
      status: 503,
      message: error instanceof Error ? error.message : 'Connection failed',
      retryAfterMs: 2000,
      cause: error,
    };
  }

  // 5. 默认：不可重试的内部错误
  return {
    retryable: false,
    code: 'INTERNAL_ERROR',
    status: 500,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  };
}

/**
 * 将 ErrorClassification 转换为对应的 BusinessException
 */
export function classificationToException(cls: ErrorClassification): BusinessException {
  switch (cls.status) {
    case 404:
      return new NotFoundException(cls.message);
    case 409:
      return new ConflictException(cls.message);
    case 504:
      return new TimeoutException(cls.message);
    default:
      return new BusinessException(cls.message, cls.code, cls.status);
  }
}

/**
 * 带自动重试的操作执行器
 *
 * @param fn 要执行的异步操作
 * @param maxRetries 最大重试次数（默认 3）
 * @returns 操作结果
 * @throws 最后一次失败的异常
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const cls = classifyError(error);

      if (!cls.retryable || attempt === maxRetries) {
        throw classificationToException(cls);
      }

      // 指数退避 + 分类建议的延迟
      const baseDelay = cls.retryAfterMs ?? 100;
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
