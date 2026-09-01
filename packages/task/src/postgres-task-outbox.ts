import { isDeepStrictEqual } from 'node:util';
import type { PostgresTaskClient } from './postgres-task-repository';
import {
  TaskOutboxConflictError,
  type AppendTaskOutboxInput,
  type ClaimTaskOutboxInput,
  type TaskOutboxRecord,
  type TaskOutboxRepository,
  type TaskOutboxStatus,
} from './task-outbox';

interface AsyncJobOutboxRow {
  id: string;
  taskId: string;
  topic: string;
  payload: unknown;
  status: TaskOutboxStatus;
  attempt: number;
  availableAt: Date | string;
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
  publishedAt: Date | string | null;
  lastError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface CreatedAsyncJobOutboxRow extends AsyncJobOutboxRow {
  __created: boolean;
}

const APPEND_OUTBOX_SQL = `
  WITH inserted AS (
    INSERT INTO async_job_outbox (
      "id", "taskId", "topic", "payload", "status", "attempt",
      "availableAt", "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, $3, $4::jsonb, 'PENDING', 0,
      $5, $6, $6
    )
    ON CONFLICT ("id") DO NOTHING
    RETURNING *
  )
  SELECT inserted.*, TRUE AS "__created"
  FROM inserted
  UNION ALL
  SELECT existing.*, FALSE AS "__created"
  FROM async_job_outbox AS existing
  WHERE existing."id" = $1
    AND NOT EXISTS (SELECT 1 FROM inserted)
  LIMIT 1
`;

const CLAIM_OUTBOX_SQL = `
  WITH candidates AS (
    SELECT "id"
    FROM async_job_outbox
    WHERE "availableAt" <= $4
      AND (
        "status" = 'PENDING'
        OR (
          "status" = 'PUBLISHING'
          AND "leaseExpiresAt" <= $4
        )
      )
    ORDER BY "createdAt" ASC
    LIMIT $5
    FOR UPDATE SKIP LOCKED
  )
  UPDATE async_job_outbox AS events
  SET
    "status" = 'PUBLISHING',
    "workerId" = $1,
    "leaseToken" = $2,
    "leaseExpiresAt" = $3,
    "attempt" = events."attempt" + 1,
    "updatedAt" = $4
  FROM candidates
  WHERE events."id" = candidates."id"
    AND $3 > $4
  RETURNING events.*
`;

const MARK_OUTBOX_PUBLISHED_SQL = `
  UPDATE async_job_outbox
  SET
    "status" = 'PUBLISHED',
    "workerId" = NULL,
    "leaseToken" = NULL,
    "leaseExpiresAt" = NULL,
    "publishedAt" = $3,
    "updatedAt" = $3,
    "lastError" = NULL
  WHERE "id" = $1
    AND "status" = 'PUBLISHING'
    AND "leaseToken" = $2
    AND "leaseExpiresAt" > $3
  RETURNING "id"
`;

const RESCHEDULE_OUTBOX_SQL = `
  UPDATE async_job_outbox
  SET
    "status" = 'PENDING',
    "workerId" = NULL,
    "leaseToken" = NULL,
    "leaseExpiresAt" = NULL,
    "availableAt" = $3,
    "lastError" = $4,
    "updatedAt" = $5
  WHERE "id" = $1
    AND "status" = 'PUBLISHING'
    AND "leaseToken" = $2
    AND "leaseExpiresAt" > $5
  RETURNING "id"
`;

function parseJson<T>(value: unknown): T {
  if (typeof value !== 'string') return value as T;
  return JSON.parse(value) as T;
}

function optionalDate(value: Date | string | null): Date | undefined {
  return value === null ? undefined : new Date(value);
}

/** PostgreSQL outbox repository with atomic multi-dispatcher claims. */
export class PostgresTaskOutboxRepository<
  TPayload = unknown,
> implements TaskOutboxRepository<TPayload> {
  constructor(private readonly client: PostgresTaskClient) {}

  async append(input: AppendTaskOutboxInput<TPayload>): Promise<{
    record: TaskOutboxRecord<TPayload>;
    created: boolean;
  }> {
    const result = await this.client.query<CreatedAsyncJobOutboxRow>(APPEND_OUTBOX_SQL, [
      input.id,
      input.taskId,
      input.topic,
      JSON.stringify(input.payload),
      input.availableAt ?? input.now,
      input.now,
    ]);
    let row: CreatedAsyncJobOutboxRow | undefined = result.rows[0];
    if (!row) {
      // See PostgresTaskRepository.create(): the conflict row can be outside
      // the INSERT statement's initial snapshot after waiting on a concurrent writer.
      const existing = await this.client.query<AsyncJobOutboxRow>(
        'SELECT * FROM async_job_outbox WHERE "id" = $1 LIMIT 1',
        [input.id],
      );
      row = existing.rows[0] as CreatedAsyncJobOutboxRow | undefined;
      if (row) row.__created = false;
    }
    if (!row) throw new Error(`Outbox event could not be created: ${input.id}`);
    if (
      row.taskId !== input.taskId ||
      row.topic !== input.topic ||
      !isDeepStrictEqual(parseJson<TPayload>(row.payload), input.payload)
    ) {
      throw new TaskOutboxConflictError(input.id);
    }
    return { record: this.toRecord(row), created: row.__created };
  }

  async claimBatch(input: ClaimTaskOutboxInput): Promise<TaskOutboxRecord<TPayload>[]> {
    if (input.limit < 1 || input.leaseExpiresAt.getTime() <= input.now.getTime()) return [];
    const result = await this.client.query<AsyncJobOutboxRow>(CLAIM_OUTBOX_SQL, [
      input.workerId,
      input.leaseToken,
      input.leaseExpiresAt,
      input.now,
      input.limit,
    ]);
    return result.rows.map((row) => this.toRecord(row));
  }

  async markPublished(id: string, leaseToken: string, now: Date): Promise<boolean> {
    const result = await this.client.query<{ id: string }>(MARK_OUTBOX_PUBLISHED_SQL, [
      id,
      leaseToken,
      now,
    ]);
    return result.rows.length === 1;
  }

  async reschedule(
    id: string,
    leaseToken: string,
    availableAt: Date,
    errorSummary: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.client.query<{ id: string }>(RESCHEDULE_OUTBOX_SQL, [
      id,
      leaseToken,
      availableAt,
      errorSummary,
      now,
    ]);
    return result.rows.length === 1;
  }

  private toRecord(row: AsyncJobOutboxRow): TaskOutboxRecord<TPayload> {
    return {
      id: row.id,
      taskId: row.taskId,
      topic: row.topic,
      payload: parseJson<TPayload>(row.payload),
      status: row.status,
      attempt: row.attempt,
      availableAt: new Date(row.availableAt),
      workerId: row.workerId ?? undefined,
      leaseToken: row.leaseToken ?? undefined,
      leaseExpiresAt: optionalDate(row.leaseExpiresAt),
      publishedAt: optionalDate(row.publishedAt),
      lastError: row.lastError ?? undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }
}
