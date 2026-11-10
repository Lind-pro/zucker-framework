import {
  assertTaskTransition,
  isTerminalTaskStatus,
  requiresTaskLease,
} from './task-state-machine';
import {
  TaskIdempotencyConflictError,
  type ClaimTaskInput,
  type CreateTaskInput,
  type CreateTaskResult,
  type FindExpiredTaskLeasesInput,
  type FindReadyQueuedTasksInput,
  type HeartbeatTaskInput,
  type ReportTaskProgressInput,
  type RecoverExpiredTaskLeaseInput,
  type TaskRecord,
  type TaskRepository,
  type TransitionTaskInput,
} from './task-repository';

function cloneTask<TPayload, TResult>(
  task: TaskRecord<TPayload, TResult>,
): TaskRecord<TPayload, TResult> {
  return {
    ...task,
    resource: { ...task.resource },
    error: task.error
      ? { ...task.error, metadata: task.error.metadata ? { ...task.error.metadata } : undefined }
      : undefined,
    availableAt: new Date(task.availableAt),
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
    startedAt: task.startedAt ? new Date(task.startedAt) : undefined,
    completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
    leaseExpiresAt: task.leaseExpiresAt ? new Date(task.leaseExpiresAt) : undefined,
    heartbeatAt: task.heartbeatAt ? new Date(task.heartbeatAt) : undefined,
  };
}

type ReadyOrderKey = Pick<TaskRecord<unknown, unknown>, 'availableAt' | 'createdAt' | 'id'>;

/** Same ordering as the PostgreSQL repository: availableAt, createdAt, id. */
function compareReadyOrder(a: ReadyOrderKey, b: ReadyOrderKey): number {
  return (
    a.availableAt.getTime() - b.availableAt.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

/**
 * Reference implementation for contract tests and local development only.
 * Production applications must use a repository with durable storage and atomic conditional updates.
 */
export class InMemoryTaskRepository<
  TPayload = unknown,
  TResult = unknown,
> implements TaskRepository<TPayload, TResult> {
  private readonly tasks = new Map<string, TaskRecord<TPayload, TResult>>();
  private readonly idempotencyIndex = new Map<string, string>();

  async create(input: CreateTaskInput<TPayload>): Promise<CreateTaskResult<TPayload, TResult>> {
    const existingId = this.idempotencyIndex.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.tasks.get(existingId);
      if (!existing) throw new Error(`Task index is corrupted for key ${input.idempotencyKey}`);
      if (existing.idempotencyFingerprint !== input.idempotencyFingerprint) {
        throw new TaskIdempotencyConflictError(input.idempotencyKey);
      }
      return { task: cloneTask(existing), created: false };
    }
    if (this.tasks.has(input.id)) throw new Error(`Task already exists: ${input.id}`);
    if (input.maxAttempts < 1) throw new RangeError('maxAttempts must be at least 1');

    const task: TaskRecord<TPayload, TResult> = {
      id: input.id,
      kind: input.kind,
      resource: { ...input.resource },
      userId: input.userId,
      orderId: input.orderId,
      status: 'QUEUED',
      progress: 0,
      attempt: 0,
      maxAttempts: input.maxAttempts,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: input.idempotencyFingerprint,
      handlerVersion: input.handlerVersion,
      payload: input.payload,
      availableAt: new Date(input.availableAt ?? input.now),
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
      version: 0,
    };
    this.tasks.set(task.id, task);
    this.idempotencyIndex.set(task.idempotencyKey, task.id);
    return { task: cloneTask(task), created: true };
  }

  async findById(id: string): Promise<TaskRecord<TPayload, TResult> | null> {
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : null;
  }

  async findByIdempotencyKey(key: string): Promise<TaskRecord<TPayload, TResult> | null> {
    const id = this.idempotencyIndex.get(key);
    return id ? this.findById(id) : null;
  }

  async claim(input: ClaimTaskInput): Promise<TaskRecord<TPayload, TResult> | null> {
    const task = this.tasks.get(input.id);
    if (
      !task ||
      task.status !== 'QUEUED' ||
      task.availableAt.getTime() > input.now.getTime() ||
      task.attempt >= task.maxAttempts ||
      input.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      return null;
    }

    task.status = 'PROCESSING';
    task.workerId = input.workerId;
    task.leaseToken = input.leaseToken;
    task.leaseExpiresAt = new Date(input.leaseExpiresAt);
    task.heartbeatAt = new Date(input.now);
    task.startedAt ??= new Date(input.now);
    task.attempt += 1;
    task.updatedAt = new Date(input.now);
    task.version += 1;
    return cloneTask(task);
  }

  async heartbeat(input: HeartbeatTaskInput): Promise<boolean> {
    const task = this.tasks.get(input.id);
    if (
      !task ||
      !requiresTaskLease(task.status) ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt.getTime() <= input.now.getTime() ||
      input.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      return false;
    }

    task.heartbeatAt = new Date(input.now);
    task.leaseExpiresAt = new Date(input.leaseExpiresAt);
    task.updatedAt = new Date(input.now);
    task.version += 1;
    return true;
  }

  async reportProgress(
    input: ReportTaskProgressInput,
  ): Promise<TaskRecord<TPayload, TResult> | null> {
    const task = this.tasks.get(input.id);
    if (
      !task ||
      !requiresTaskLease(task.status) ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      return null;
    }

    task.stage = input.stage ?? task.stage;
    task.progress = Math.max(task.progress, clampProgress(input.progress));
    task.updatedAt = new Date(input.now);
    task.version += 1;
    return cloneTask(task);
  }

  async transition(
    input: TransitionTaskInput<TResult>,
  ): Promise<TaskRecord<TPayload, TResult> | null> {
    const task = this.tasks.get(input.id);
    if (!task || task.status !== input.from) return null;
    assertTaskTransition(input.from, input.to);
    if (input.from === 'QUEUED' && input.to === 'PROCESSING') return null;

    if (requiresTaskLease(input.from)) {
      if (
        !input.leaseToken ||
        task.leaseToken !== input.leaseToken ||
        !task.leaseExpiresAt ||
        task.leaseExpiresAt.getTime() <= input.now.getTime()
      ) {
        return null;
      }
    }

    task.status = input.to;
    task.stage = input.stage ?? task.stage;
    task.progress = input.to === 'COMPLETED' ? 100 : clampProgress(input.progress ?? task.progress);
    task.result = input.result ?? task.result;
    task.error = input.error;
    task.providerRequestId = input.providerRequestId ?? task.providerRequestId;
    task.availableAt = new Date(input.availableAt ?? task.availableAt);
    task.updatedAt = new Date(input.now);
    task.version += 1;

    if (input.to === 'QUEUED' || input.to === 'RETRYING' || isTerminalTaskStatus(input.to)) {
      task.workerId = undefined;
      task.leaseToken = undefined;
      task.leaseExpiresAt = undefined;
      task.heartbeatAt = undefined;
    }
    if (isTerminalTaskStatus(input.to)) task.completedAt = new Date(input.now);
    return cloneTask(task);
  }

  async findExpiredLeases(
    input: FindExpiredTaskLeasesInput,
  ): Promise<TaskRecord<TPayload, TResult>[]> {
    if (input.limit < 1) return [];
    return [...this.tasks.values()]
      .filter(
        (task) =>
          requiresTaskLease(task.status) &&
          Boolean(task.leaseExpiresAt && task.leaseExpiresAt.getTime() <= input.now.getTime()),
      )
      .sort((a, b) => (a.leaseExpiresAt?.getTime() ?? 0) - (b.leaseExpiresAt?.getTime() ?? 0))
      .slice(0, input.limit)
      .map(cloneTask);
  }

  async findReadyQueued(
    input: FindReadyQueuedTasksInput,
  ): Promise<TaskRecord<TPayload, TResult>[]> {
    if (input.limit < 1) return [];
    return [...this.tasks.values()]
      .filter(
        (task) =>
          (task.status === 'QUEUED' || (input.includeRetrying && task.status === 'RETRYING')) &&
          task.availableAt.getTime() <= input.now.getTime() &&
          task.attempt < task.maxAttempts,
      )
      .sort(compareReadyOrder)
      .filter((task) => !input.after || compareReadyOrder(task, input.after) > 0)
      .slice(
        input.after ? 0 : (input.offset ?? 0),
        (input.after ? 0 : (input.offset ?? 0)) + input.limit,
      )
      .map(cloneTask);
  }

  async recoverExpiredLease(
    input: RecoverExpiredTaskLeaseInput,
  ): Promise<TaskRecord<TPayload, TResult> | null> {
    const task = this.tasks.get(input.id);
    if (
      !task ||
      !requiresTaskLease(task.status) ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt.getTime() > input.now.getTime()
    ) {
      return null;
    }

    const attemptsExhausted = task.attempt >= task.maxAttempts;
    task.status = attemptsExhausted ? 'FAILED' : 'QUEUED';
    task.error = input.error;
    task.availableAt = new Date(input.availableAt ?? input.now);
    task.workerId = undefined;
    task.leaseToken = undefined;
    task.leaseExpiresAt = undefined;
    task.heartbeatAt = undefined;
    task.updatedAt = new Date(input.now);
    task.version += 1;
    if (attemptsExhausted) task.completedAt = new Date(input.now);
    return cloneTask(task);
  }

  async cancel(id: string, now: Date): Promise<TaskRecord<TPayload, TResult> | null> {
    const task = this.tasks.get(id);
    if (!task || isTerminalTaskStatus(task.status)) return null;

    task.status = 'CANCELLED';
    task.workerId = undefined;
    task.leaseToken = undefined;
    task.leaseExpiresAt = undefined;
    task.heartbeatAt = undefined;
    task.completedAt = new Date(now);
    task.updatedAt = new Date(now);
    task.version += 1;
    return cloneTask(task);
  }
}
