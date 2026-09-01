import { TASK_STATUSES, type TaskStatus } from './task-state-machine';
import type { TaskFailureCategory } from './task-repository';
import type { PostgresTaskClient } from './postgres-task-repository';

export const TASK_TIMELINE_EVENT_TYPES = [
  'SNAPSHOT',
  'CREATED',
  'CLAIMED',
  'PROGRESS',
  'RETRY_SCHEDULED',
  'REQUEUED',
  'LEASE_RECOVERED',
  'MANUAL_REDRIVE',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'STATUS_CHANGED',
] as const;

export type TaskTimelineEventType = (typeof TASK_TIMELINE_EVENT_TYPES)[number];

interface TaskTimelineEventRow {
  id: string;
  taskId: string;
  sequence: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string;
  stage: string | null;
  progress: number;
  attempt: number;
  maxAttempts: number;
  errorCode: string | null;
  errorCategory: string | null;
  errorRetryable: boolean | null;
  workerId: string | null;
  providerRequestId: string | null;
  createdAt: Date | string;
}

export interface OwnedTaskTimelineEvent {
  id: string;
  taskId: string;
  sequence: number;
  type: TaskTimelineEventType;
  fromStatus?: TaskStatus;
  toStatus: TaskStatus;
  stage?: string;
  progress: number;
  attempt: number;
  maxAttempts: number;
  error?: {
    code: string;
    category: TaskFailureCategory;
    summary: string;
    retryable: boolean;
  };
  createdAt: Date;
}

export interface TaskTimelineEvent extends OwnedTaskTimelineEvent {
  workerId?: string;
  providerRequestId?: string;
}

const PUBLIC_COLUMNS = `events."id", events."taskId", events."sequence",
  events."eventType", events."fromStatus"::text AS "fromStatus",
  events."toStatus"::text AS "toStatus", events."stage", events."progress",
  events."attempt", events."maxAttempts", events."errorCode",
  events."errorCategory", events."errorRetryable",
  events."createdAt"`;

function status(value: string | null): TaskStatus | undefined {
  if (value === null) return undefined;
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error(`Unknown task status returned by PostgreSQL: ${value}`);
}

function requiredStatus(value: string): TaskStatus {
  const parsed = status(value);
  if (parsed) return parsed;
  throw new Error('Task timeline event is missing its destination status');
}

function eventType(value: string): TaskTimelineEventType {
  if ((TASK_TIMELINE_EVENT_TYPES as readonly string[]).includes(value)) {
    return value as TaskTimelineEventType;
  }
  throw new Error(`Unknown task timeline event type returned by PostgreSQL: ${value}`);
}

function toOwnedEvent(row: TaskTimelineEventRow): OwnedTaskTimelineEvent {
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
    taskId: row.taskId,
    sequence: row.sequence,
    type: eventType(row.eventType),
    fromStatus: status(row.fromStatus),
    toStatus: requiredStatus(row.toStatus),
    stage: row.stage ?? undefined,
    progress: row.progress,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    error,
    createdAt: new Date(row.createdAt),
  };
}

/** Payload-free timeline reader with separate owner and operator projections. */
export class PostgresTaskTimelineReader {
  constructor(private readonly client: PostgresTaskClient) {}

  async listOwned(taskId: string, userId: string, limit = 200): Promise<OwnedTaskTimelineEvent[]> {
    if (!userId) return [];
    const result = await this.client.query<TaskTimelineEventRow>(
      `SELECT ${PUBLIC_COLUMNS}
       FROM async_job_events AS events
       INNER JOIN async_jobs AS tasks ON tasks."id" = events."taskId"
       WHERE events."taskId" = $1 AND tasks."userId" = $2
       ORDER BY events."sequence" ASC
       LIMIT $3`,
      [taskId, userId, this.normalizeLimit(limit)],
    );
    return result.rows.map(toOwnedEvent);
  }

  async listByTaskId(taskId: string, limit = 500): Promise<TaskTimelineEvent[]> {
    const result = await this.client.query<TaskTimelineEventRow>(
      `SELECT ${PUBLIC_COLUMNS}, events."workerId", events."providerRequestId"
       FROM async_job_events AS events
       WHERE events."taskId" = $1
       ORDER BY events."sequence" ASC
       LIMIT $2`,
      [taskId, this.normalizeLimit(limit)],
    );
    return result.rows.map((row) => ({
      ...toOwnedEvent(row),
      workerId: row.workerId ?? undefined,
      providerRequestId: row.providerRequestId ?? undefined,
    }));
  }

  private normalizeLimit(limit: number): number {
    return Math.max(1, Math.min(Math.trunc(limit), 1_000));
  }
}
