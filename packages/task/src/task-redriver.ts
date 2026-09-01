import type { PostgresTaskClient } from './postgres-task-repository';

export interface RedriveFailedTaskInput {
  taskId: string;
  now: Date;
  additionalAttempts?: number;
  stage?: string;
}

export interface TaskRedriveResult {
  taskId: string;
  attempt: number;
  maxAttempts: number;
  version: number;
  availableAt: Date;
}

interface RedriveRow {
  id: string;
  attempt: number;
  maxAttempts: number;
  version: number;
  availableAt: Date | string;
}

/** Generic terminal-failure redrive primitive; domain projections and outbox stay application-owned. */
export class PostgresTaskRedriver {
  constructor(private readonly client: PostgresTaskClient) {}

  async redriveFailed(input: RedriveFailedTaskInput): Promise<TaskRedriveResult | null> {
    const additionalAttempts = input.additionalAttempts ?? 1;
    if (
      !Number.isInteger(additionalAttempts) ||
      additionalAttempts < 1 ||
      additionalAttempts > 10
    ) {
      throw new RangeError('additionalAttempts must be an integer between 1 and 10');
    }
    const result = await this.client.query<RedriveRow>(
      `UPDATE async_jobs
       SET "status" = 'QUEUED'::async_job_status,
           "stage" = $2,
           "maxAttempts" = GREATEST("maxAttempts", "attempt" + $3),
           "result" = NULL,
           "errorCode" = NULL,
           "errorCategory" = NULL,
           "errorSummary" = NULL,
           "errorRetryable" = NULL,
           "errorMetadata" = NULL,
           "providerRequestId" = NULL,
           "workerId" = NULL,
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "heartbeatAt" = NULL,
           "availableAt" = $4,
           "completedAt" = NULL,
           "updatedAt" = $4,
           "version" = "version" + 1
       WHERE "id" = $1 AND "status" = 'FAILED'::async_job_status
       RETURNING "id", "attempt", "maxAttempts", "version", "availableAt"`,
      [input.taskId, input.stage ?? 'manual-redrive', additionalAttempts, input.now],
    );
    const row = result.rows[0];
    return row
      ? {
          taskId: row.id,
          attempt: row.attempt,
          maxAttempts: row.maxAttempts,
          version: row.version,
          availableAt: new Date(row.availableAt),
        }
      : null;
  }
}
