import type { TaskErrorSummary, TaskFailureCategory } from '@zucker-framework/task';

export type AITaskErrorCode =
  | 'AI_TASK_INVALID'
  | 'AI_TASK_INSUFFICIENT_CREDITS'
  | 'AI_TASK_IDEMPOTENCY_CONFLICT'
  | 'AI_TASK_COST_CHANGED';

/** Submission errors. Suggested HTTP mapping: INVALID 400, INSUFFICIENT_CREDITS 402, others 409. */
export class AITaskError extends Error {
  constructor(
    readonly code: AITaskErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'AITaskError';
  }
}

export class AITaskValidationError extends AITaskError {
  constructor(readonly field: string) {
    super('AI_TASK_INVALID', `Invalid AI task ${field}`);
    this.name = 'AITaskValidationError';
  }
}

/** Thrown by a CreditHoldPort when the owner cannot cover the hold; the submit transaction rolls back. */
export class AITaskInsufficientCreditsError extends AITaskError {
  constructor(
    readonly required: number,
    readonly available?: number,
  ) {
    super('AI_TASK_INSUFFICIENT_CREDITS', 'Insufficient credits for this AI task');
    this.name = 'AITaskInsufficientCreditsError';
  }
}

export class AITaskIdempotencyConflictError extends AITaskError {
  constructor() {
    super('AI_TASK_IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different AI task request');
    this.name = 'AITaskIdempotencyConflictError';
  }
}

export class AITaskCostChangedError extends AITaskError {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super('AI_TASK_COST_CHANGED', 'The AI task price changed; quote again');
    this.name = 'AITaskCostChangedError';
  }
}

/**
 * A worker-side failure that must end the task now (no automatic retry). The handler writes the
 * terminal FAILED state and releases the hold itself, so the host's classifier never decides it.
 * `summary` is a fixed, user-safe text: raw provider messages are never persisted.
 */
export class AITaskFatalError extends Error {
  constructor(
    readonly code: string,
    readonly category: TaskFailureCategory,
    readonly summary: string,
  ) {
    super(summary);
    this.name = 'AITaskFatalError';
  }

  toSummary(): TaskErrorSummary {
    return { code: this.code, category: this.category, summary: this.summary, retryable: false };
  }
}

/** Raised when a re-hosted output breaks the size/content-type/address limits. */
export class AITaskOutputRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`AI task output rejected: ${reason}`);
    this.name = 'AITaskOutputRejectedError';
  }
}
