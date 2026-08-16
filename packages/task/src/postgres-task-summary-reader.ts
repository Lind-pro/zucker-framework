import { TASK_STATUSES, type TaskStatus } from './task-state-machine';
import type { TaskFailureCategory, TaskResourceRef } from './task-repository';
import type { PostgresTaskClient } from './postgres-task-repository';

export interface TaskSummaryError {
  code: string;
  category: TaskFailureCategory;
  summary: string;
  retryable: boolean;
}

export interface TaskSummary {
  id: string;
  kind: string;
  resource: TaskResourceRef;
  status: TaskStatus;
  stage?: string;
  progress: number;
  attempt: number;
  maxAttempts: number;
  error?: TaskSummaryError;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
  version: number;
}

export interface ListOwnedTaskSummariesInput {
  userId: string;
  statuses?: readonly TaskStatus[];
  limit?: number;
}

interface TaskSummaryRow {
  id: string;
  kind: string;
  resourceType: string;
  resourceId: string;
  status: string;
  stage: string | null;
  progress: number;
  attempt: number;
  maxAttempts: number;
  errorCode: string | null;
  errorCategory: string | null;
  errorRetryable: boolean | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  updatedAt: Date | string;
  version: number;
}

const SAFE_SUMMARY_COLUMNS = `
  "id", "kind", "resourceType", "resourceId", "status"::text AS "status",
  "stage", "progress", "attempt", "maxAttempts", "errorCode",
  "errorCategory", "errorRetryable", "createdAt",
  "startedAt", "completedAt", "updatedAt", "version"
`;

function optionalDate(value: Date | string | null): Date | undefined {
  return value === null ? undefined : new Date(value);
}

function taskStatus(value: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error(`Unknown task status returned by PostgreSQL: ${value}`);
}

function toSummary(row: TaskSummaryRow): TaskSummary {
  const error = row.errorCode
    ? {
        code: row.errorCode,
        category: (row.errorCategory ?? 'UNKNOWN') as TaskFailureCategory,
        summary: row.errorCode,
        retryable: row.errorRetryable ?? false,
      }
    : undefined;
  return {
    id: row.id,
    kind: row.kind,
    resource: { type: row.resourceType, id: row.resourceId },
    status: taskStatus(row.status),
    stage: row.stage ?? undefined,
    progress: row.progress,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    error,
    createdAt: new Date(row.createdAt),
    startedAt: optionalDate(row.startedAt),
    completedAt: optionalDate(row.completedAt),
    updatedAt: new Date(row.updatedAt),
    version: row.version,
  };
}

/** Read-only, owner-scoped task projection that never loads task payloads or results. */
export class PostgresTaskSummaryReader {
  constructor(private readonly client: PostgresTaskClient) {}

  async findOwnedById(taskId: string, userId: string): Promise<TaskSummary | null> {
    const result = await this.client.query<TaskSummaryRow>(
      `SELECT ${SAFE_SUMMARY_COLUMNS}
       FROM async_jobs
       WHERE "id" = $1 AND "userId" = $2
       LIMIT 1`,
      [taskId, userId],
    );
    return result.rows[0] ? toSummary(result.rows[0]) : null;
  }

  async listOwned(input: ListOwnedTaskSummariesInput): Promise<TaskSummary[]> {
    if (!input.userId) return [];
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const statuses = input.statuses?.length ? [...new Set(input.statuses)] : undefined;
    if (statuses?.some((status) => !(TASK_STATUSES as readonly string[]).includes(status))) {
      throw new RangeError('statuses contains an unknown task status');
    }
    const statusPlaceholders = statuses
      ?.map((_, index) => `$${index + 2}::async_job_status`)
      .join(', ');
    const result = statuses
      ? await this.client.query<TaskSummaryRow>(
          `SELECT ${SAFE_SUMMARY_COLUMNS}
           FROM async_jobs
           WHERE "userId" = $1
             AND "status" IN (${statusPlaceholders})
           ORDER BY "createdAt" DESC, "id" DESC
           LIMIT $${statuses.length + 2}`,
          [input.userId, ...statuses, limit],
        )
      : await this.client.query<TaskSummaryRow>(
          `SELECT ${SAFE_SUMMARY_COLUMNS}
           FROM async_jobs
           WHERE "userId" = $1
           ORDER BY "createdAt" DESC, "id" DESC
           LIMIT $2`,
          [input.userId, limit],
        );
    return result.rows.map(toSummary);
  }
}
