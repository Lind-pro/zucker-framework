import { PostgresTaskRepository, TASK_STATUSES, type PostgresTaskClient, type TaskStatus } from '@zucker-framework/task';
import type {
  AITaskExecutionState, AITaskHoldState, AITaskKind, AITaskManagementView, AITaskOutputView, AITaskPayload, AITaskStoredOutput, AITaskView,
} from './types';
import type { AIMediaResultLike } from './ports';

/** Verified provider outcome waiting for the lease owner (never an unverified callback body). */
export type StoredCallbackOutcome =
  | { state: 'succeeded'; outputs: { url: string }[] }
  | { state: 'failed' };

export interface AITaskRow {
  id: string;
  ownerId: string;
  kind: AITaskKind;
  providerId: string;
  model: string;
  cost: number;
  holdId: string | null;
  holdState: AITaskHoldState;
  providerTaskId: string | null;
  pollCount: number;
  /** Consecutive failed status polls. */
  pollErrors: number;
  /** Runs that ended by scheduling the next poll (not failures); attempt - deferrals = failed runs + 1. */
  deferrals: number;
  nextPollAt: Date | null;
  wakeRequestedAt: Date | null;
  deadlineAt: Date;
  callbackOutcome: StoredCallbackOutcome | null;
  executionState?: AITaskExecutionState;
  generatedOutputs?: AIMediaResultLike[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AITaskJoinedRow extends AITaskRow {
  status: TaskStatus;
  stage: string | null;
  progress: number;
  attempt: number;
  errorCode: string | null;
  errorSummary: string | null;
  completedAt: Date | null;
  payload: AITaskPayload;
}

export interface AITaskListCursor {
  createdAt: Date;
  id: string;
}

export interface AITaskPage<T> {
  items: T[];
  next: AITaskListCursor | null;
}

const ACTIVE = new Set<TaskStatus>(['QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING']);

function json<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}
function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}
function optionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}
function status(value: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error(`Unknown task status: ${value}`);
}

function toRow(raw: Record<string, unknown>): AITaskRow {
  return {
    id: raw.id as string,
    ownerId: raw.ownerId as string,
    kind: raw.kind as AITaskKind,
    providerId: raw.providerId as string,
    model: raw.model as string,
    cost: Number(raw.cost),
    holdId: (raw.holdId as string | null) ?? null,
    holdState: raw.holdState as AITaskHoldState,
    providerTaskId: (raw.providerTaskId as string | null) ?? null,
    pollCount: Number(raw.pollCount),
    pollErrors: Number(raw.pollErrors ?? 0),
    deferrals: Number(raw.deferrals ?? 0),
    nextPollAt: optionalDate(raw.nextPollAt),
    wakeRequestedAt: optionalDate(raw.wakeRequestedAt),
    deadlineAt: date(raw.deadlineAt),
    callbackOutcome: raw.callbackOutcome == null ? null : json<StoredCallbackOutcome>(raw.callbackOutcome),
    executionState: raw.executionState as AITaskExecutionState,
    generatedOutputs: raw.generatedOutputs == null ? null : json<AIMediaResultLike[]>(raw.generatedOutputs),
    createdAt: date(raw.createdAt),
    updatedAt: date(raw.updatedAt),
  };
}

function toJoined(raw: Record<string, unknown>): AITaskJoinedRow {
  return {
    ...toRow(raw),
    status: status(String(raw.status)),
    stage: (raw.stage as string | null) ?? null,
    progress: Number(raw.progress),
    attempt: Number(raw.attempt),
    errorCode: (raw.errorCode as string | null) ?? null,
    errorSummary: (raw.errorSummary as string | null) ?? null,
    completedAt: optionalDate(raw.completedAt),
    payload: json<AITaskPayload>(raw.payload),
  };
}

const JOINED_COLUMNS = `a.*, j."status"::text AS "status", j."stage", j."progress", j."attempt", j."errorCode",
  j."errorSummary", j."completedAt", j."payload"`;

/**
 * Raw SQL access to ai_tasks / ai_task_outputs on any PostgresTaskClient (pg, PGlite, Prisma raw adapter).
 *
 * LOCK ORDER INVARIANT: every transaction that writes or row-locks both tables locks the
 * async_jobs row FIRST and the ai_tasks row SECOND (then ai_task_outputs, then the credit ledger
 * through the hold port). The task repository (cancel, transition, claim, lease recovery) only ever
 * touches async_jobs, so any ai_tasks write that shares a transaction with an async_jobs write must
 * take `lockJob` before touching ai_tasks. Violating the order deadlocks e.g. a cancel (async_jobs ->
 * ai_tasks) racing a poll deferral or a callback (previously ai_tasks -> async_jobs).
 * Note: `UPDATE ai_tasks ... FROM async_jobs` does NOT lock the joined async_jobs row.
 */
export class PostgresAITaskStore {
  /** Row-locks the durable job (first step of the lock order). Returns false when it does not exist. */
  async lockJob(client: PostgresTaskClient, id: string): Promise<boolean> {
    const result = await client.query<{ id: string }>('SELECT "id" FROM async_jobs WHERE "id" = $1 FOR UPDATE', [id]);
    return result.rows.length === 1;
  }

  async insert(client: PostgresTaskClient, row: AITaskRow): Promise<boolean> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO ai_tasks ("id", "ownerId", "kind", "providerId", "model", "cost", "holdId", "holdState",
        "providerTaskId", "pollCount", "nextPollAt", "wakeRequestedAt", "deadlineAt", "callbackOutcome", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 0, NULL, NULL, $9, NULL, $10, $10)
       ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
      [row.id, row.ownerId, row.kind, row.providerId, row.model, row.cost, row.holdId, row.holdState, row.deadlineAt, row.createdAt],
    );
    return result.rows.length === 1;
  }

  async find(client: PostgresTaskClient, id: string, forUpdate = false): Promise<AITaskJoinedRow | null> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${JOINED_COLUMNS} FROM ai_tasks a JOIN async_jobs j ON j."id" = a."id" WHERE a."id" = $1
       ${forUpdate ? 'FOR UPDATE OF a' : ''}`,
      [id],
    );
    return result.rows[0] ? toJoined(result.rows[0]) : null;
  }

  async findOwned(client: PostgresTaskClient, ownerId: string, id: string, forUpdate = false): Promise<AITaskJoinedRow | null> {
    const row = await this.find(client, id, forUpdate);
    return row && row.ownerId === ownerId ? row : null;
  }

  /** Writes a recoverable execution checkpoint under the same lease fence as task transitions. */
  async checkpoint(client: PostgresTaskClient, input: {
    id: string; leaseToken: string; now: Date; state: AITaskExecutionState;
    providerTaskId?: string; outputs?: readonly AIMediaResultLike[]; stored?: readonly AITaskStoredOutput[];
  }): Promise<boolean> {
    if (!(await this.lockJob(client, input.id))) return false;
    const result = await client.query<{ id: string }>(
      `UPDATE ai_tasks AS a SET "executionState" = $3,
         "providerTaskId" = COALESCE($4, a."providerTaskId"),
         "generatedOutputs" = CASE WHEN $3 = 'STORED' THEN NULL ELSE COALESCE($5::jsonb, a."generatedOutputs") END,
         "updatedAt" = $6
       FROM async_jobs AS j
       WHERE a."id" = $1 AND j."id" = a."id" AND j."leaseToken" = $2
         AND j."leaseExpiresAt" > $7 AND j."status"::text = 'PROCESSING'
         AND ($3 <> 'SUBMITTING' OR a."executionState" = 'NEW') RETURNING a."id"`,
      [input.id, input.leaseToken, input.state, input.providerTaskId ?? null,
        input.outputs ? JSON.stringify(input.outputs) : null, input.now, input.now],
    );
    if (!result.rows.length) return false;
    if (input.stored) await this.insertOutputs(client, input.stored, input.now);
    return true;
  }

  /**
   * Worker-side write fenced by the current attempt lease: the update applies only while the
   * durable row is still owned by `leaseToken` and its lease has not expired.
   */
  async updateFenced(
    client: PostgresTaskClient,
    input: { id: string; leaseToken: string; now: Date; providerTaskId?: string; pollCount?: number; nextPollAt?: Date; consumeCallback?: boolean },
  ): Promise<boolean> {
    if (!(await this.lockJob(client, input.id))) return false;
    const result = await client.query<{ id: string }>(
      `UPDATE ai_tasks AS a SET
         "providerTaskId" = COALESCE($3, a."providerTaskId"),
         "pollCount" = COALESCE($4, a."pollCount"),
         "nextPollAt" = COALESCE($5, a."nextPollAt"),
         "callbackOutcome" = CASE WHEN $6::boolean THEN NULL ELSE a."callbackOutcome" END,
         "updatedAt" = $7
       FROM async_jobs AS j
       WHERE a."id" = $1 AND j."id" = a."id" AND j."leaseToken" = $2
         AND j."leaseExpiresAt" > $8 AND j."status"::text IN ('PROCESSING', 'WAITING_PROVIDER')
       RETURNING a."id"`,
      // Separate parameters per column: ai_tasks and async_jobs may use different timestamp types.
      [input.id, input.leaseToken, input.providerTaskId ?? null, input.pollCount ?? null, input.nextPollAt ?? null,
        input.consumeCallback ?? false, input.now, input.now],
    );
    return result.rows.length === 1;
  }

  /**
   * Ends a run without holding its lease while the provider works: records the poll state and moves the
   * durable row PROCESSING -> RETRYING -> QUEUED with availableAt = nextPollAt, all in one transaction
   * fenced by the attempt lease (a stale lease changes nothing and gets false).
   */
  async defer(
    client: PostgresTaskClient,
    input: { id: string; leaseToken: string; now: Date; nextPollAt: Date; providerTaskId?: string; pollCount: number; pollErrors: number; stage: string; progress?: number },
  ): Promise<boolean> {
    // Lock order: async_jobs before ai_tasks (the transitions below write async_jobs).
    if (!(await this.lockJob(client, input.id))) return false;
    const updated = await client.query<{ id: string }>(
      `UPDATE ai_tasks AS a SET
         "providerTaskId" = COALESCE($3, a."providerTaskId"),
         "pollCount" = $4, "pollErrors" = $5, "deferrals" = a."deferrals" + 1,
         "nextPollAt" = $6, "updatedAt" = $7
       FROM async_jobs AS j
       WHERE a."id" = $1 AND j."id" = a."id" AND j."leaseToken" = $2
         AND j."leaseExpiresAt" > $8 AND j."status"::text = 'PROCESSING'
       RETURNING a."id"`,
      [input.id, input.leaseToken, input.providerTaskId ?? null, input.pollCount, input.pollErrors, input.nextPollAt, input.now, input.now],
    );
    if (updated.rows.length !== 1) return false;
    const repository = new PostgresTaskRepository(client);
    const retrying = await repository.transition({
      id: input.id, from: 'PROCESSING', to: 'RETRYING', leaseToken: input.leaseToken, stage: input.stage,
      progress: input.progress, providerRequestId: input.providerTaskId, availableAt: input.nextPollAt, now: input.now,
    });
    if (!retrying) throw new Error('AI task lease changed inside the deferral transaction');
    const queued = await repository.transition({ id: input.id, from: 'RETRYING', to: 'QUEUED', availableAt: input.nextPollAt, now: input.now });
    if (!queued) throw new Error('AI task could not be requeued inside the deferral transaction');
    return true;
  }

  /**
   * Brings a deferred (QUEUED) row's availableAt forward to `now`. Scheduling only: QUEUED holds no
   * lease or result, and the next claim still goes through the fenced task repository.
   */
  private async advanceQueued(client: PostgresTaskClient, id: string, now: Date): Promise<void> {
    await client.query(
      `UPDATE async_jobs SET "availableAt" = $2, "updatedAt" = $3 WHERE "id" = $1 AND "status"::text = 'QUEUED' AND "availableAt" > $4`,
      [id, now, now, now],
    );
  }

  /** HELD -> terminal CAS on the caller's transaction. False means another path already settled it. */
  async settleHoldState(client: PostgresTaskClient, id: string, to: 'CONFIRMED' | 'RELEASED', now: Date): Promise<boolean> {
    const result = await client.query<{ id: string }>(
      `UPDATE ai_tasks SET "holdState" = $2, "updatedAt" = $3 WHERE "id" = $1 AND "holdState" = 'HELD' RETURNING "id"`,
      [id, to, now],
    );
    return result.rows.length === 1;
  }

  /** Terminal tasks no longer need provider URLs or inline result bytes for recovery. */
  async clearGeneratedOutputs(client: PostgresTaskClient, id: string): Promise<void> {
    await client.query('UPDATE ai_tasks SET "generatedOutputs" = NULL WHERE "id" = $1', [id]);
  }

  async insertOutputs(client: PostgresTaskClient, outputs: readonly AITaskStoredOutput[], now: Date): Promise<void> {
    for (const output of outputs) {
      await client.query(
        `INSERT INTO ai_task_outputs ("taskId", "index", "storageKey", "contentType", "bytes", "sha256", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT ("taskId", "index") DO NOTHING`,
        [output.taskId, output.index, output.storageKey, output.contentType, output.bytes, output.sha256, now],
      );
    }
  }

  /**
   * Finds the active task of a provider task id and locks its durable row first (lock order), so the
   * following ai_tasks update and the async_jobs schedule change keep async_jobs -> ai_tasks.
   */
  private async lockActiveByProviderTask(client: PostgresTaskClient, providerId: string, providerTaskId: string): Promise<string | null> {
    const found = await client.query<{ id: string }>(
      `SELECT a."id" FROM ai_tasks a WHERE a."providerId" = $1 AND a."providerTaskId" = $2`,
      [providerId, providerTaskId],
    );
    const id = found.rows[0]?.id;
    if (!id) return null;
    return (await this.lockJob(client, id)) ? id : null;
  }

  /** Records a verified terminal outcome once (first verified callback wins) and asks for an immediate poll. */
  async recordCallbackOutcome(
    client: PostgresTaskClient, providerId: string, providerTaskId: string, outcome: StoredCallbackOutcome | null, now: Date,
  ): Promise<string | null> {
    const locked = await this.lockActiveByProviderTask(client, providerId, providerTaskId);
    if (!locked) return null;
    const result = await client.query<{ id: string }>(
      `UPDATE ai_tasks AS a SET
         "callbackOutcome" = COALESCE(a."callbackOutcome", $3::jsonb),
         "nextPollAt" = $4, "wakeRequestedAt" = $4, "updatedAt" = $4
       FROM async_jobs AS j
       WHERE a."id" = $5 AND a."providerId" = $1 AND a."providerTaskId" = $2 AND j."id" = a."id"
         AND j."status"::text IN ('QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING')
       RETURNING a."id"`,
      [providerId, providerTaskId, outcome === null ? null : JSON.stringify(outcome), now, locked],
    );
    const id = result.rows[0]?.id ?? null;
    if (id) await this.advanceQueued(client, id, now);
    return id;
  }

  /**
   * Unverified callback: only moves the next poll forward, at most once per `minIntervalMs`.
   * It never touches results, status or holds.
   */
  async requestEarlyPoll(
    client: PostgresTaskClient, providerId: string, providerTaskId: string, now: Date, minIntervalMs: number,
  ): Promise<string | null> {
    const locked = await this.lockActiveByProviderTask(client, providerId, providerTaskId);
    if (!locked) return null;
    const result = await client.query<{ id: string }>(
      `UPDATE ai_tasks AS a SET "nextPollAt" = $3, "wakeRequestedAt" = $3, "updatedAt" = $3
       FROM async_jobs AS j
       WHERE a."id" = $5 AND a."providerId" = $1 AND a."providerTaskId" = $2 AND j."id" = a."id"
         AND j."status"::text IN ('QUEUED', 'RETRYING', 'PROCESSING', 'WAITING_PROVIDER')
         AND (a."wakeRequestedAt" IS NULL OR a."wakeRequestedAt" <= $4)
         AND (a."nextPollAt" IS NULL OR a."nextPollAt" > $3)
       RETURNING a."id"`,
      [providerId, providerTaskId, now, new Date(now.getTime() - minIntervalMs), locked],
    );
    const id = result.rows[0]?.id ?? null;
    if (id) await this.advanceQueued(client, id, now);
    return id;
  }

  /** Holds still HELD although the durable task already ended (lease-recovery FAILED, external cancel ...). */
  async findOrphanedHolds(client: PostgresTaskClient, limit: number): Promise<string[]> {
    const result = await client.query<{ id: string }>(
      `SELECT a."id" FROM ai_tasks a JOIN async_jobs j ON j."id" = a."id"
       WHERE (a."holdState" = 'HELD' OR a."generatedOutputs" IS NOT NULL) AND j."status"::text IN ('FAILED', 'CANCELLED')
       ORDER BY a."updatedAt" ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }

  async outputs(client: PostgresTaskClient, taskIds: readonly string[]): Promise<Map<string, AITaskStoredOutput[]>> {
    const map = new Map<string, AITaskStoredOutput[]>();
    if (!taskIds.length) return map;
    const result = await client.query<Record<string, unknown>>(
      `SELECT "taskId", "index", "storageKey", "contentType", "bytes", "sha256" FROM ai_task_outputs
       WHERE "taskId" = ANY($1::text[]) ORDER BY "taskId", "index"`,
      [[...taskIds]],
    );
    for (const row of result.rows) {
      const output: AITaskStoredOutput = {
        taskId: row.taskId as string, index: Number(row.index), storageKey: row.storageKey as string,
        contentType: row.contentType as string, bytes: Number(row.bytes), sha256: row.sha256 as string,
      };
      map.set(output.taskId, [...(map.get(output.taskId) ?? []), output]);
    }
    return map;
  }

  async list(
    client: PostgresTaskClient,
    filter: { ownerId?: string; kind?: AITaskKind; status?: TaskStatus; before?: AITaskListCursor; limit: number },
  ): Promise<AITaskJoinedRow[]> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${JOINED_COLUMNS} FROM ai_tasks a JOIN async_jobs j ON j."id" = a."id"
       WHERE ($1::text IS NULL OR a."ownerId" = $1)
         AND ($2::text IS NULL OR a."kind" = $2)
         AND ($3::text IS NULL OR (CASE
               WHEN j."status"::text IN ('QUEUED', 'RETRYING') AND a."providerTaskId" IS NOT NULL
                 AND a."executionState" NOT IN ('GENERATED', 'STORED') THEN 'WAITING_PROVIDER'
               ELSE j."status"::text END) = $3)
         AND ($4::boolean OR (a."createdAt", a."id") < ($5, $6))
       ORDER BY a."createdAt" DESC, a."id" DESC
       LIMIT $7`,
      [filter.ownerId ?? null, filter.kind ?? null, filter.status ?? null, !filter.before,
        filter.before?.createdAt ?? new Date(0), filter.before?.id ?? '', filter.limit],
    );
    return result.rows.map(toJoined);
  }
}

function outputViews(outputs: readonly AITaskStoredOutput[] | undefined): AITaskOutputView[] {
  return (outputs ?? []).map(({ index, contentType, bytes }) => ({ index, contentType, bytes }));
}

/**
 * A task whose provider already accepted the request is waiting for the provider even while its
 * durable row is QUEUED/RETRYING between polls (no lease is held while waiting).
 */
export function projectedStatus(row: Pick<AITaskJoinedRow, 'status' | 'providerTaskId' | 'executionState'>): TaskStatus {
  return (row.status === 'QUEUED' || row.status === 'RETRYING') && row.providerTaskId
    && row.executionState !== 'GENERATED' && row.executionState !== 'STORED' ? 'WAITING_PROVIDER' : row.status;
}

export function toView(row: AITaskJoinedRow, outputs?: readonly AITaskStoredOutput[], promptLimit?: number): AITaskView {
  const prompt = row.payload.input.prompt;
  const status = projectedStatus(row);
  return {
    id: row.id,
    kind: row.kind,
    providerId: row.providerId,
    model: row.model,
    status,
    stage: row.stage,
    progress: row.progress,
    cost: row.cost,
    charge: row.holdState,
    prompt: promptLimit !== undefined && prompt.length > promptLimit ? `${prompt.slice(0, promptLimit)}…` : prompt,
    error: row.errorCode && (status === 'FAILED' || status === 'RETRYING')
      ? { code: row.errorCode, summary: row.errorSummary ?? row.errorCode } : null,
    outputs: row.status === 'COMPLETED' ? outputViews(outputs) : [],
    canCancel: ACTIVE.has(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export function toManagementView(row: AITaskJoinedRow, outputs: readonly AITaskStoredOutput[] | undefined, promptLimit: number): AITaskManagementView {
  return { ...toView(row, outputs, promptLimit), ownerId: row.ownerId, attempt: row.attempt };
}
