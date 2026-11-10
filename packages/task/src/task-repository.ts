import type { TaskStatus } from './task-state-machine';

export interface TaskResourceRef {
  type: string;
  id: string;
}

export type TaskFailureCategory =
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'PROVIDER_5XX'
  | 'PROVIDER_TIMEOUT'
  | 'INTERNAL'
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'CONTENT_POLICY'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface TaskErrorSummary {
  code: string;
  category: TaskFailureCategory;
  summary: string;
  retryable: boolean;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TaskRecord<TPayload = unknown, TResult = unknown> {
  id: string;
  kind: string;
  resource: TaskResourceRef;
  userId?: string;
  orderId?: string;
  status: TaskStatus;
  stage?: string;
  progress: number;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  handlerVersion: string;
  payload: TPayload;
  result?: TResult;
  error?: TaskErrorSummary;
  providerRequestId?: string;
  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  heartbeatAt?: Date;
  availableAt: Date;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
  version: number;
}

export interface CreateTaskInput<TPayload> {
  id: string;
  kind: string;
  resource: TaskResourceRef;
  userId?: string;
  orderId?: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  handlerVersion: string;
  payload: TPayload;
  maxAttempts: number;
  availableAt?: Date;
  now: Date;
}

export interface CreateTaskResult<TPayload, TResult> {
  task: TaskRecord<TPayload, TResult>;
  created: boolean;
}

export interface ClaimTaskInput {
  id: string;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  now: Date;
}

export interface HeartbeatTaskInput {
  id: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  now: Date;
}

export interface ReportTaskProgressInput {
  id: string;
  leaseToken: string;
  stage?: string;
  progress: number;
  now: Date;
}

export interface TransitionTaskInput<TResult> {
  id: string;
  from: TaskStatus;
  to: TaskStatus;
  leaseToken?: string;
  stage?: string;
  progress?: number;
  result?: TResult;
  error?: TaskErrorSummary;
  providerRequestId?: string;
  availableAt?: Date;
  now: Date;
}

export interface FindExpiredTaskLeasesInput {
  now: Date;
  limit: number;
}

/** Keyset position of the last row of the previous page (ordering: availableAt, createdAt, id). */
export interface ReadyTaskCursor {
  availableAt: Date;
  createdAt: Date;
  id: string;
}

export interface FindReadyQueuedTasksInput {
  now: Date;
  limit: number;
  /** Prefer `after`; OFFSET pages skip rows when earlier rows are claimed between calls. */
  offset?: number;
  /** Return only rows ordered after this cursor. Takes precedence over `offset`. */
  after?: ReadyTaskCursor;
  /**
   * Also return RETRYING rows whose availableAt has passed. RETRYING holds no lease, so a
   * worker that stopped between RETRYING and QUEUED would otherwise strand the row.
   */
  includeRetrying?: boolean;
}

export interface RecoverExpiredTaskLeaseInput {
  id: string;
  leaseToken: string;
  now: Date;
  availableAt?: Date;
  error: TaskErrorSummary;
}

export interface TaskRepository<TPayload = unknown, TResult = unknown> {
  create(input: CreateTaskInput<TPayload>): Promise<CreateTaskResult<TPayload, TResult>>;
  findById(id: string): Promise<TaskRecord<TPayload, TResult> | null>;
  findByIdempotencyKey(key: string): Promise<TaskRecord<TPayload, TResult> | null>;
  /** The only operation allowed to start a queued attempt and issue its lease. */
  claim(input: ClaimTaskInput): Promise<TaskRecord<TPayload, TResult> | null>;
  heartbeat(input: HeartbeatTaskInput): Promise<boolean>;
  /** Reports monotonic progress only while the current attempt lease is valid. */
  reportProgress(input: ReportTaskProgressInput): Promise<TaskRecord<TPayload, TResult> | null>;
  /** Applies lifecycle transitions other than QUEUED -> PROCESSING, which must use claim(). */
  transition(input: TransitionTaskInput<TResult>): Promise<TaskRecord<TPayload, TResult> | null>;
  /** Returns durable work that should have a corresponding transport message. */
  findReadyQueued(input: FindReadyQueuedTasksInput): Promise<TaskRecord<TPayload, TResult>[]>;
  findExpiredLeases(input: FindExpiredTaskLeasesInput): Promise<TaskRecord<TPayload, TResult>[]>;
  recoverExpiredLease(
    input: RecoverExpiredTaskLeaseInput,
  ): Promise<TaskRecord<TPayload, TResult> | null>;
  cancel(id: string, now: Date): Promise<TaskRecord<TPayload, TResult> | null>;
}

export class TaskIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key was reused with a different request: ${idempotencyKey}`);
    this.name = 'TaskIdempotencyConflictError';
  }
}
