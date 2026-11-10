import { AIErrorType } from './ai-provider.interface';

export class AICallTimeoutError extends Error {
  readonly type = AIErrorType.TIMEOUT;

  constructor(readonly timeoutMs: number) {
    super(`AI call timed out after ${timeoutMs}ms`);
    this.name = 'AICallTimeoutError';
  }
}

export class AICallAbortedError extends Error {
  readonly type = AIErrorType.CANCELLED;

  constructor(reason?: unknown) {
    super('AI call was cancelled', reason instanceof Error ? { cause: reason } : undefined);
    this.name = 'AICallAbortedError';
  }
}

export interface ClassifiedAIError {
  type: AIErrorType;
  retryable: boolean;
}

export type AICallFailureOutcome = 'error' | 'timeout' | 'cancelled';

/** Diagnostic outcome classification; it does not change provider retry decisions. */
export function classifyAICallOutcome(error: Error): AICallFailureOutcome {
  const message = error.message?.toLowerCase() ?? '';
  if (
    error instanceof AICallAbortedError ||
    error.name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('cancelled')
  )
    return 'cancelled';
  if (
    error instanceof AICallTimeoutError ||
    message.includes('timeout') ||
    message.includes('timed out')
  )
    return 'timeout';
  return 'error';
}

export function classifyAIError(error: Error): ClassifiedAIError {
  if (error instanceof AICallTimeoutError) {
    return { type: AIErrorType.TIMEOUT, retryable: false };
  }
  if (error instanceof AICallAbortedError || error.name === 'AbortError') {
    return { type: AIErrorType.CANCELLED, retryable: false };
  }

  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  const message = error.message.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /authentication|unauthorized|forbidden|invalid_api_key/.test(message)
  ) {
    return { type: AIErrorType.AUTH, retryable: false };
  }
  // Exhausted quota/billing is reported as 429 by several providers but will not recover by retrying.
  if (/insufficient_quota|quota.?exceeded|exceeded your current quota/.test(message)) {
    return { type: AIErrorType.INVALID_REQUEST, retryable: false };
  }
  if (status === 429 || /rate.?limit|too many requests/.test(message)) {
    return { type: AIErrorType.RATE_LIMIT, retryable: true };
  }
  if (status !== undefined && status >= 500) {
    return { type: AIErrorType.SERVER_ERROR, retryable: true };
  }
  if (status !== undefined && status >= 400) {
    return { type: AIErrorType.INVALID_REQUEST, retryable: false };
  }
  if (/network|fetch failed|econnreset|econnrefused|enotfound|socket hang up/.test(message)) {
    return { type: AIErrorType.NETWORK, retryable: true };
  }
  if (/content.?policy|safety|moderation/.test(message)) {
    return { type: AIErrorType.CONTENT_POLICY, retryable: false };
  }
  if (/invalid_request|insufficient_quota/.test(message)) {
    return { type: AIErrorType.INVALID_REQUEST, retryable: false };
  }
  return { type: AIErrorType.UNKNOWN, retryable: true };
}
