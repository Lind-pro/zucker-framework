import { Injectable, Logger } from '@nestjs/common';

export interface CallOptions {
  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Descriptive context for log messages */
  context?: string;
  /** Custom function to determine if an error is retryable (default: all errors are retryable) */
  isRetryable?: (error: Error) => boolean;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms for exponential backoff (default: 10000) */
  maxDelayMs?: number;
}

/** Errors that should typically not be retried */
const NON_RETRYABLE_PATTERNS = [
  'authentication',
  'unauthorized',
  'forbidden',
  'invalid_api_key',
  'insufficient_quota',
  'invalid_request',
] as const;

/** Default retryable error check: rate limits and server errors are retryable, auth errors are not */
function defaultIsRetryable(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return !NON_RETRYABLE_PATTERNS.some((pattern) => msg.includes(pattern));
}

@Injectable()
export class AICallWrapper {
  private readonly logger = new Logger(AICallWrapper.name);

  async callWithRetry<T>(
    fn: () => Promise<T>,
    options: CallOptions = {},
  ): Promise<T> {
    const {
      timeoutMs = 60_000,
      maxAttempts = 3,
      context = 'AI 调用',
      isRetryable = defaultIsRetryable,
      baseDelayMs = 1000,
      maxDelayMs = 10_000,
    } = options;

    let lastError: Error = new Error(`${context}: 未知错误`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const startTime = Date.now();
        const result = await this.withTimeout(fn(), timeoutMs);
        const duration = Date.now() - startTime;

        this.logger.log(
          `[${context}] 成功 (attempt=${attempt}, ${duration}ms)`,
        );
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `[${context}] 失败 (attempt=${attempt}/${maxAttempts}): ${lastError.message}`,
        );

        // Do not retry non-retryable errors
        if (!isRetryable(lastError)) {
          this.logger.warn(`[${context}] 错误不可重试，直接抛出`);
          throw lastError;
        }

        if (attempt < maxAttempts) {
          const delay = this.calculateDelay(attempt, baseDelayMs, maxDelayMs);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /** Calculate delay with exponential backoff and jitter to avoid thundering herd */
  private calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
    // Add jitter: random value between 50% and 100% of the calculated delay
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.floor(cappedDelay * jitter);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`调用超时 (${ms}ms)`));
        }
      }, ms);

      promise
        .then((val) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(val);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
