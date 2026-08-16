import type { TaskErrorSummary, TaskFailureCategory } from './task-repository';

export interface TaskRetryContext {
  error: TaskErrorSummary;
  attempt: number;
  maxAttempts: number;
  retryAfterMs?: number;
}

export type TaskRetryDecision =
  | { retry: false; reason: 'NON_RETRYABLE' | 'ATTEMPTS_EXHAUSTED' }
  | { retry: true; delayMs: number };

export interface TaskRetryPolicy {
  decide(context: TaskRetryContext): TaskRetryDecision;
}

export interface ExponentialTaskRetryPolicyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  retryableCategories?: readonly TaskFailureCategory[];
  random?: () => number;
}

const defaultRetryableCategories: readonly TaskFailureCategory[] = [
  'RATE_LIMIT',
  'NETWORK',
  'PROVIDER_5XX',
  'PROVIDER_TIMEOUT',
  'INTERNAL',
];

export class ExponentialTaskRetryPolicy implements TaskRetryPolicy {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly retryableCategories: ReadonlySet<TaskFailureCategory>;
  private readonly random: () => number;

  constructor(options: ExponentialTaskRetryPolicyOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.retryableCategories = new Set(options.retryableCategories ?? defaultRetryableCategories);
    this.random = options.random ?? Math.random;

    if (this.baseDelayMs < 0) throw new RangeError('baseDelayMs cannot be negative');
    if (this.maxDelayMs < this.baseDelayMs) {
      throw new RangeError('maxDelayMs cannot be lower than baseDelayMs');
    }
    if (this.jitterRatio < 0 || this.jitterRatio > 1) {
      throw new RangeError('jitterRatio must be between 0 and 1');
    }
  }

  decide(context: TaskRetryContext): TaskRetryDecision {
    if (context.attempt >= context.maxAttempts) {
      return { retry: false, reason: 'ATTEMPTS_EXHAUSTED' };
    }
    if (!context.error.retryable || !this.retryableCategories.has(context.error.category)) {
      return { retry: false, reason: 'NON_RETRYABLE' };
    }

    const exponential = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** Math.max(0, context.attempt - 1),
    );
    const retryAfter = Math.max(0, context.retryAfterMs ?? 0);
    const base = Math.max(exponential, retryAfter);
    const spread = Math.min(this.maxDelayMs, base) * this.jitterRatio;
    const jittered = base - spread + this.random() * spread * 2;
    return { retry: true, delayMs: Math.round(Math.min(this.maxDelayMs, jittered)) };
  }
}
