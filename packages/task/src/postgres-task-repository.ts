import {
  assertTaskTransition,
  isTerminalTaskStatus,
  requiresTaskLease,
  TASK_STATUSES,
  type TaskStatus,
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
  type TaskErrorSummary,
  type TaskFailureCategory,
  type TaskRecord,
  type TaskRepository,
  type TransitionTaskInput,
} from './task-repository';

export interface PostgresQueryResult<TRow> {
  rows: TRow[];
}

/** Minimal port implemented by pg clients, PGlite, and thin Prisma raw-query adapters. */
export interface PostgresTaskClient {
  query<TRow>(sql: string, parameters?: readonly unknown[]): Promise<PostgresQueryResult<TRow>>;
}

interface AsyncJobRow {
  id: string;
  kind: string;
  resourceType: string;
  resourceId: string;
  userId: string | null;
  orderId: string | null;
  status: string;
  stage: string | null;
  progress: number;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  handlerVersion: string;
  payload: unknown;
  result: unknown | null;
  errorCode: string | null;
  errorCategory: string | null;
  errorSummary: string | null;
  errorRetryable: boolean | null;
  errorMetadata: unknown | null;
  providerRequestId: string | null;
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
  heartbeatAt: Date | string | null;
  availableAt: Date | string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  updatedAt: Date | string;
  version: number;
}

interface CreatedAsyncJobRow extends AsyncJobRow {
  __created: boolean;
}

const CREATE_TASK_SQL = `
  WITH inserted AS (
    INSERT INTO async_jobs (
      "id", "kind", "resourceType", "resourceId", "userId", "orderId",
      "status", "progress", "attempt", "maxAttempts", "idempotencyKey",
      "idempotencyFingerprint", "handlerVersion", "payload", "availableAt",
      "createdAt", "updatedAt", "version"
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      'QUEUED', 0, 0, $7, $8,
      $9, $10, $11::jsonb, $12,
      $13, $13, 0
    )
    ON CONFLICT ("idempotencyKey") DO NOTHING
    RETURNING *
  )
  SELECT inserted.*, TRUE AS "__created"
  FROM inserted
  UNION ALL
  SELECT existing.*, FALSE AS "__created"
  FROM async_jobs AS existing
  WHERE existing."idempotencyKey" = $8
    AND NOT EXISTS (SELECT 1 FROM inserted)
  LIMIT 1
`;

const CLAIM_TASK_SQL = `
  UPDATE async_jobs
  SET
    "status" = 'PROCESSING',
    "workerId" = $2,
    "leaseToken" = $3,
    "leaseExpiresAt" = $4,
    "heartbeatAt" = $5,
    "startedAt" = COALESCE("startedAt", $5),
    "attempt" = "attempt" + 1,
    "updatedAt" = $5,
    "version" = "version" + 1
  WHERE "id" = $1
    AND "status" = 'QUEUED'
    AND "availableAt" <= $5
    AND "attempt" < "maxAttempts"
    AND $4 > $5
  RETURNING *
`;

const HEARTBEAT_TASK_SQL = `
  UPDATE async_jobs
  SET
    "heartbeatAt" = $4,
    "leaseExpiresAt" = $3,
    "updatedAt" = $4,
    "version" = "version" + 1
  WHERE "id" = $1
    AND "status" IN ('PROCESSING', 'WAITING_PROVIDER')
    AND "leaseToken" = $2
    AND "leaseExpiresAt" > $4
    AND $3 > $4
  RETURNING "id"
`;

const REPORT_TASK_PROGRESS_SQL = `
  UPDATE async_jobs
  SET
    "stage" = COALESCE($3::text, "stage"),
    "progress" = GREATEST("progress", GREATEST(0, LEAST(100, $4::integer))),
    "updatedAt" = $5,
    "version" = "version" + 1
  WHERE "id" = $1
    AND "status" IN ('PROCESSING', 'WAITING_PROVIDER')
    AND "leaseToken" = $2
    AND "leaseExpiresAt" > $5
  RETURNING *
`;

const TRANSITION_TASK_SQL = `
  UPDATE async_jobs
  SET
    "status" = $3::async_job_status,
    "stage" = COALESCE($5::text, "stage"),
    "progress" = CASE
      WHEN $3 = 'COMPLETED' THEN 100
      WHEN $6::integer IS NULL THEN "progress"
      ELSE GREATEST(0, LEAST(100, $6::integer))
    END,
    "result" = COALESCE($7::jsonb, "result"),
    "errorCode" = $8::text,
    "errorCategory" = $9::text,
    "errorSummary" = $10::text,
    "errorRetryable" = $11::boolean,
    "errorMetadata" = $12::jsonb,
    "providerRequestId" = COALESCE($13::text, "providerRequestId"),
    "availableAt" = COALESCE($14::timestamptz, "availableAt"),
    "workerId" = CASE WHEN $16::boolean THEN NULL ELSE "workerId" END,
    "leaseToken" = CASE WHEN $16::boolean THEN NULL ELSE "leaseToken" END,
    "leaseExpiresAt" = CASE WHEN $16::boolean THEN NULL ELSE "leaseExpiresAt" END,
    "heartbeatAt" = CASE WHEN $16::boolean THEN NULL ELSE "heartbeatAt" END,
    "completedAt" = CASE WHEN $17::boolean THEN $15::timestamptz ELSE "completedAt" END,
    "updatedAt" = $15::timestamptz,
    "version" = "version" + 1
  WHERE "id" = $1
    AND "status" = $2::async_job_status
    AND (
      NOT $18::boolean
      OR (
        $4::text IS NOT NULL
        AND "leaseToken" = $4::text
        AND "leaseExpiresAt" > $15::timestamptz
      )
    )
  RETURNING *
`;

const FIND_EXPIRED_LEASES_SQL = `
  SELECT *
  FROM async_jobs
  WHERE "status" IN ('PROCESSING', 'WAITING_PROVIDER')
    AND "leaseExpiresAt" <= $1
  ORDER BY "leaseExpiresAt" ASC
  LIMIT $2
`;

const FIND_READY_QUEUED_TASKS_SQL = `
  SELECT *
  FROM async_jobs
  WHERE "status" = 'QUEUED'
    AND "availableAt" <= $1
    AND "attempt" < "maxAttempts"
  ORDER BY "availableAt" ASC, "createdAt" ASC
  LIMIT $2
  OFFSET $3
`;

const RECOVER_EXPIRED_LEASE_SQL = `
  UPDATE async_jobs
  SET
    "status" = CASE
      WHEN "attempt" >= "maxAttempts" THEN 'FAILED'::async_job_status
      ELSE 'QUEUED'::async_job_status
    END,
    "errorCode" = $4,
    "errorCategory" = $5,
    "errorSummary" = $6,
    "errorRetryable" = $7,
    "errorMetadata" = $8::jsonb,
    "availableAt" = COALESCE($9, $3),
    "workerId" = NULL,
    "leaseToken" = NULL,
    "leaseExpiresAt" = NULL,
    "heartbeatAt" = NULL,
    "completedAt" = CASE
      WHEN "attempt" >= "maxAttempts" THEN $3
      ELSE "completedAt"
    END,
    "updatedAt" = $3,
    "version" = "version" + 1
  WHERE "id" = $1
    AND "status" IN ('PROCESSING', 'WAITING_PROVIDER')
    AND "leaseToken" = $2
    AND "leaseExpiresAt" <= $3
  RETURNING *
`;

const CANCEL_TASK_SQL = `
  UPDATE async_jobs
  SET
    "status" = 'CANCELLED',
    "workerId" = NULL,
    "leaseToken" = NULL,
    "leaseExpiresAt" = NULL,
    "heartbeatAt" = NULL,
    "completedAt" = $2,
    "updatedAt" = $2,
    "version" = "version" + 1
  WHERE "id" = $1
    AND "status" NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
  RETURNING *
`;

function jsonParameter(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== 'string') return value as T;
  return JSON.parse(value) as T;
}

function optionalDate(value: Date | string | null): Date | undefined {
  return value === null ? undefined : new Date(value);
}

function taskStatus(value: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error(`Unknown task status returned by PostgreSQL: ${value}`);
}

function taskError(row: AsyncJobRow): TaskErrorSummary | undefined {
  if (!row.errorCode) return undefined;
  return {
    code: row.errorCode,
    category: (row.errorCategory ?? 'UNKNOWN') as TaskFailureCategory,
    summary: row.errorSummary ?? row.errorCode,
    retryable: row.errorRetryable ?? false,
    metadata: row.errorMetadata
      ? parseJson<Readonly<Record<string, string | number | boolean | null>>>(row.errorMetadata)
      : undefined,
  };
}

/**
 * PostgreSQL reference repository for the published Prisma schema fragment.
 * All ownership-changing operations use conditional UPDATE ... RETURNING statements.
 */
export class PostgresTaskRepository<
  TPayload = unknown,
  TResult = unknown,
> implements TaskRepository<TPayload, TResult> {
  constructor(private readonly client: PostgresTaskClient) {}

  async create(input: CreateTaskInput<TPayload>): Promise<CreateTaskResult<TPayload, TResult>> {
    if (input.maxAttempts < 1) throw new RangeError('maxAttempts must be at least 1');
    const result = await this.client.query<CreatedAsyncJobRow>(CREATE_TASK_SQL, [
      input.id,
      input.kind,
      input.resource.type,
      input.resource.id,
      input.userId ?? null,
      input.orderId ?? null,
      input.maxAttempts,
      input.idempotencyKey,
      input.idempotencyFingerprint,
      input.handlerVersion,
      jsonParameter(input.payload),
      input.availableAt ?? input.now,
      input.now,
    ]);
    const row = result.rows[0];
    if (!row) {
      // ON CONFLICT may wait for another transaction whose row is outside this
      // statement's original READ COMMITTED snapshot. A second statement sees it.
      const existing = await this.findByIdempotencyKey(input.idempotencyKey);
      if (!existing) throw new Error(`Task already exists with a different id: ${input.id}`);
      if (existing.idempotencyFingerprint !== input.idempotencyFingerprint) {
        throw new TaskIdempotencyConflictError(input.idempotencyKey);
      }
      return { task: existing, created: false };
    }
    if (row.idempotencyFingerprint !== input.idempotencyFingerprint) {
      throw new TaskIdempotencyConflictError(input.idempotencyKey);
    }
    return { task: this.toTask(row), created: row.__created };
  }

  async findById(id: string): Promise<TaskRecord<TPayload, TResult> | null> {
    const result = await this.client.query<AsyncJobRow>(
      'SELECT * FROM async_jobs WHERE "id" = $1 LIMIT 1',
      [id],
    );
    return result.rows[0] ? this.toTask(result.rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<TaskRecord<TPayload, TResult> | null> {
    const result = await this.client.query<AsyncJobRow>(
      'SELECT * FROM async_jobs WHERE "idempotencyKey" = $1 LIMIT 1',
      [key],
    );
    return result.rows[0] ? this.toTask(result.rows[0]) : null;
  }

  async claim(input: ClaimTaskInput): Promise<TaskRecord<TPayload, TResult> | null> {
    const result = await this.client.query<AsyncJobRow>(CLAIM_TASK_SQL, [
      input.id,
      input.workerId,
      input.leaseToken,
      input.leaseExpiresAt,
      input.now,
    ]);
    return result.rows[0] ? this.toTask(result.rows[0]) : null;
  }

  async heartbeat(input: HeartbeatTaskInput): Promise<boolean> {
    const result = await this.client.query<{ id: string }>(HEARTBEAT_TASK_SQL, [
      input.id,
      input.leaseToken,
      input.leaseExpiresAt,
      input.now,
    ]);
    return result.rows.length === 1;
  }

  async reportProgress(
    input: ReportTaskProgressInput,
  ): Promise<TaskRecord<TPayload, TResult> | null> {
    const result = await this.client.query<AsyncJobRow>(REPORT_TASK_PROGRESS_SQL, [
      input.id,
      input.leaseToken,
      input.stage ?? null,
      input.progress,
      input.now,
    ]);
    return result.rows[0] ? this.toTask(result.rows[0]) : null;
  }

  async transition(
    input: TransitionTaskInput<TResult>,
  ): Promise<TaskRecord<TPayload, TResult> | null> {
    assertTaskTransition(input.from, input.to);
    if (input.from === 'QUEUED' && input.to === 'PROCESSING') return null;

    const clearsLease =
      input.to === 'QUEUED' || input.to === 'RETRYING' || isTerminalTaskStatus(input.to);
    const error = input.error;
    const result = await this.client.query<AsyncJobRow>(TRANSITION_TASK_SQL, [
      input.id,
      input.from,
      input.to,
      input.leaseToken ?? null,
      input.stage ?? null,
      input.progress ?? null,
      jsonParameter(input.result),
      error?.code ?? null,
      error?.category ?? null,
      error?.summary ?? null,
      error?.retryable ?? null,
      jsonParameter(error?.metadata),
      input.providerRequestId ?? null,
      input.availableAt ?? null,
      input.now,
      clearsLease,
      isTerminalTaskStatus(input.to),
      requiresTaskLease(input.from),
    ]);
    return result.rows[0] ? this.toTask(result.rows[0]) : null;
  }

  async findExpiredLeases(
    input: FindExpiredTaskLeasesInput,
  ): Promise<TaskRecord<TPayload, TResult>[]> {
    if (input.limit < 1) return [];
    const result = await this.client.query<AsyncJobRow>(FIND_EXPIRED_LEASES_SQL, [
      input.now,
      input.limit,
    ]);
    return result.rows.map((row) => this.toTask(row));
  }

  async findReadyQueued(
    input: FindReadyQueuedTasksInput,
  ): Promise<TaskRecord<TPayload, TResult>[]> {
    if (input.limit < 1) return [];
    const result = await this.client.query<AsyncJobRow>(FIND_READY_QUEUED_TASKS_SQL, [
      input.now,
      input.limit,
      input.offset ?? 0,
    ]);
    return result.rows.map((row) => this.toTask(row));
  }

  async recoverExpiredLease(
    input: RecoverExpiredTaskLeaseInput,
  ): Promise<TaskRecord<TPayload, TResult> | null> {
    const result = await this.client.query<AsyncJobRow>(RECOVER_EXPIRED_LEASE_SQL, [
      input.id,
      input.leaseToken,
      input.now,
      input.error.code,
      input.error.category,
      input.error.summary,
      input.error.retryable,
      jsonParameter(input.error.metadata),
      input.availableAt ?? null,
    ]);
    return result.rows[0] ? this.toTask(result.rows[0]) : null;
  }

  async cancel(id: string, now: Date): Promise<TaskRecord<TPayload, TResult> | null> {
    const result = await this.client.query<AsyncJobRow>(CANCEL_TASK_SQL, [id, now]);
    return result.rows[0] ? this.toTask(result.rows[0]) : null;
  }

  private toTask(row: AsyncJobRow): TaskRecord<TPayload, TResult> {
    return {
      id: row.id,
      kind: row.kind,
      resource: { type: row.resourceType, id: row.resourceId },
      userId: row.userId ?? undefined,
      orderId: row.orderId ?? undefined,
      status: taskStatus(row.status),
      stage: row.stage ?? undefined,
      progress: row.progress,
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      idempotencyKey: row.idempotencyKey,
      idempotencyFingerprint: row.idempotencyFingerprint,
      handlerVersion: row.handlerVersion,
      payload: parseJson<TPayload>(row.payload),
      result: row.result === null ? undefined : parseJson<TResult>(row.result),
      error: taskError(row),
      providerRequestId: row.providerRequestId ?? undefined,
      workerId: row.workerId ?? undefined,
      leaseToken: row.leaseToken ?? undefined,
      leaseExpiresAt: optionalDate(row.leaseExpiresAt),
      heartbeatAt: optionalDate(row.heartbeatAt),
      availableAt: new Date(row.availableAt),
      createdAt: new Date(row.createdAt),
      startedAt: optionalDate(row.startedAt),
      completedAt: optionalDate(row.completedAt),
      updatedAt: new Date(row.updatedAt),
      version: row.version,
    };
  }
}
