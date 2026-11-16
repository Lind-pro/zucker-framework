import { createHash } from 'node:crypto';
import { AICallWrapper, type MediaGenerationConfig } from '@zucker-framework/ai';
import { createPublicFetch } from '@zucker-framework/core';
import {
  createTaskFingerprint,
  DurableTaskLeaseLostError,
  DurableTaskRetryScheduledError,
  isTerminalTaskStatus,
  PostgresTaskRepository,
  PostgresTaskSubmitter,
  TaskIdempotencyConflictError,
  type DurableTaskAttemptContext,
  type DurableTaskHandler,
  type PostgresTaskClient,
  type TaskErrorSummary,
  type TaskStatus,
} from '@zucker-framework/task';
import { DEFAULT_MAX_WAIT_MS, pollDelayMs, type AITaskPollingOptions } from './backoff';
import {
  AITaskCostChangedError,
  AITaskFatalError,
  AITaskIdempotencyConflictError,
  AITaskOutputRejectedError,
  AITaskValidationError,
} from './errors';
import { DEFAULT_AI_OUTPUT_CONTENT_TYPES } from './media-content';
import type {
  AICostResolver,
  AIMediaResultLike,
  AIMediaTaskLike,
  AITaskCallbackVerifierResolver,
  AITaskMediaProvider,
  AITaskProviderResolver,
  CreditHoldPort,
  OutputStorePort,
} from './ports';
import { downloadOutput, openOutput, type OpenedOutput, type OutputFetch } from './rehost';
import {
  PostgresAITaskStore,
  toManagementView,
  toView,
  type AITaskJoinedRow,
  type AITaskListCursor,
  type AITaskPage,
  type StoredCallbackOutcome,
} from './store';
import {
  AI_TASK_DURABLE_KIND,
  AI_TASK_HANDLER_VERSION,
  AI_TASK_OUTBOX_TOPIC,
  AI_TASK_RESOURCE_TYPE,
  type AITaskKind,
  type AITaskManagementView,
  type AITaskPayload,
  type AITaskStoredOutput,
  type AITaskTransactionRunner,
  type AITaskView,
  type SubmitAITaskCommand,
} from './types';
import { validateCost, validateSubmitCommand, type AITaskInputLimits } from './validation';

export interface AITaskOutputLimits {
  /** Outputs kept per task, default 4 (extra provider outputs are ignored). */
  maxOutputs?: number;
  /**
   * Byte cap per output; defaults image 20 MiB, video 200 MiB, audio 50 MiB. Enforced while streaming
   * (OutputStorePort.putStream) or while buffering (put).
   */
  maxBytes?: Partial<Record<AITaskKind, number>>;
  /** Allowed sniffed content types per kind; default DEFAULT_AI_OUTPUT_CONTENT_TYPES. */
  contentTypes?: Partial<Record<AITaskKind, readonly string[]>>;
  /** Download attempts per output for transient network errors, default 3. */
  downloadAttempts?: number;
  /** Total download/storage time per output, including retry delays. Default 120 seconds. */
  downloadTimeoutMs?: number;
}

export interface AITaskLogger {
  warn?(message: string, context: Readonly<Record<string, unknown>>): void;
  error?(message: string, context: Readonly<Record<string, unknown>>): void;
}

export interface AITaskServiceOptions<Tx extends PostgresTaskClient> {
  transactions: AITaskTransactionRunner<Tx>;
  holds: CreditHoldPort<Tx>;
  costs: AICostResolver;
  outputs: OutputStorePort;
  providers: AITaskProviderResolver;
  callbacks?: AITaskCallbackVerifierResolver;
  inputLimits?: AITaskInputLimits;
  outputLimits?: AITaskOutputLimits;
  polling?: AITaskPollingOptions;
  /** Timeout of the provider submission call, default 120 s. */
  submitTimeoutMs?: number;
  /** Timeout of one status poll, default 30 s. */
  pollTimeoutMs?: number;
  /** Durable attempts (lease losses / infrastructure errors), default 3. */
  maxAttempts?: number;
  /** SSRF-safe fetch for output URLs. Default: core `createPublicFetch()` (https:443, public addresses, no redirects). */
  fetch?: OutputFetch;
  callWrapper?: Pick<AICallWrapper, 'callWithRetry'>;
  /** Host wake hint (e.g. JobsService.wake) after submit or callback; best effort. */
  wake?(taskId: string): void;
  now?(): Date;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  logger?: AITaskLogger;
}

export interface SubmitAITaskResult {
  task: AITaskView;
  created: boolean;
}

export interface AITaskCallbackResult {
  /** False when no verifier is registered for the provider (respond 404). */
  providerKnown: boolean;
  /** Whether the verifier accepted signature/freshness (respond 401/403 when false). */
  verified: boolean;
  /** 'recorded': verified outcome stored; 'poll-scheduled': one early poll; 'none': nothing changed. */
  action: 'recorded' | 'poll-scheduled' | 'none';
}

export interface ListAITasksInput {
  limit?: number;
  before?: AITaskListCursor;
  kind?: AITaskKind;
  status?: TaskStatus;
}

/** Durable registration shape accepted by the server template's `JobsService.registerHandler`. */
export interface AITaskHandlerRegistration {
  kind: string;
  version: string;
  handler: DurableTaskHandler<AITaskPayload, AITaskExecution>;
  maxAttempts: number;
}

/** In-attempt result passed from `execute` to `complete`. */
export interface AITaskExecution {
  outputs: AITaskStoredOutput[];
}

type ProviderOutcome =
  | { state: 'pending'; providerTaskId?: string; progress?: number }
  | { state: 'succeeded'; outputs: AIMediaResultLike[] }
  | { state: 'failed' };

/** The task ended or was cancelled by someone else while this attempt waited. Not a failure of the attempt. */
class AITaskStoppedError extends Error {
  constructor(readonly taskId: string) {
    super(`AI task is no longer active: ${taskId}`);
    this.name = 'AITaskStoppedError';
  }
}

const DEFAULT_MAX_BYTES: Readonly<Record<AITaskKind, number>> = {
  image: 20 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
};
const PROVIDER_TASK_ID = /^[\x21-\x7e]{1,256}$/;

const fatal = {
  stateMissing: () => new AITaskFatalError('AI_TASK_STATE_MISSING', 'INTERNAL', 'The task state is missing'),
  providerUnavailable: () => new AITaskFatalError('AI_PROVIDER_UNAVAILABLE', 'INTERNAL', 'The AI provider is not configured'),
  unsupported: () => new AITaskFatalError('AI_PROVIDER_UNSUPPORTED', 'VALIDATION', 'The AI provider does not support this request'),
  rejected: () => new AITaskFatalError('AI_PROVIDER_REJECTED', 'UNKNOWN', 'The AI provider did not accept the request'),
  failed: () => new AITaskFatalError('AI_PROVIDER_FAILED', 'UNKNOWN', 'The AI provider could not generate a result'),
  unreachable: () => new AITaskFatalError('AI_PROVIDER_UNREACHABLE', 'NETWORK', 'The AI provider status could not be read'),
  timeout: () => new AITaskFatalError('AI_PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT', 'The AI provider did not finish in time'),
  outputMissing: () => new AITaskFatalError('AI_OUTPUT_MISSING', 'UNKNOWN', 'The AI provider returned no output'),
  outputRejected: () => new AITaskFatalError('AI_OUTPUT_REJECTED', 'VALIDATION', 'The generated output was rejected'),
  outputUnavailable: () => new AITaskFatalError('AI_OUTPUT_UNAVAILABLE', 'NETWORK', 'The generated output could not be downloaded'),
  attemptsExhausted: () => new AITaskFatalError('AI_TASK_ATTEMPTS_EXHAUSTED', 'INTERNAL', 'The task could not be processed'),
  storageFailed: () => new AITaskFatalError('AI_OUTPUT_STORAGE_FAILED', 'INTERNAL', 'The generated output could not be stored'),
  outputQuota: () => new AITaskFatalError('AI_OUTPUT_QUOTA_EXCEEDED', 'VALIDATION', 'Your storage is full; delete files and try again'),
  submissionUnknown: () => new AITaskFatalError('AI_PROVIDER_SUBMISSION_UNKNOWN', 'INTERNAL', 'The provider submission outcome could not be recovered; it was not submitted again'),
  outputCount: () => new AITaskFatalError('AI_OUTPUT_COUNT_MISMATCH', 'INTERNAL', 'The provider did not return the requested number of outputs'),
  outputTimeout: () => new AITaskFatalError('AI_OUTPUT_TIMEOUT', 'NETWORK', 'The generated output could not be stored in time'),
};

function isOutboundRejection(error: unknown): boolean {
  // Matched by name as well: a second copy of core (tsx/vitest) breaks instanceof.
  const name = error instanceof Error ? error.name : '';
  return name === 'OutboundUrlRejectedError' || error instanceof AITaskOutputRejectedError;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Normalises a provider answer (sync result or async task) without trusting its shape. */
export function normalizeProviderResult(result: AIMediaResultLike | AIMediaTaskLike | null | undefined): ProviderOutcome {
  if (!result || typeof result !== 'object') return { state: 'failed' };
  const task = result as AIMediaTaskLike;
  if (typeof task.taskId === 'string' && typeof task.status === 'string') {
    const status = task.status.toUpperCase();
    if (status === 'COMPLETED') {
      const outputs = Array.isArray(task.outputs) && task.outputs.length ? [...task.outputs] : task.result ? [task.result] : [];
      return { state: 'succeeded', outputs };
    }
    if (status === 'FAILED') return { state: 'failed' };
    const progress = typeof task.progress === 'number' && Number.isFinite(task.progress) ? task.progress : undefined;
    return { state: 'pending', providerTaskId: task.taskId, progress };
  }
  const sync = result as AIMediaResultLike;
  return { state: 'succeeded', outputs: Array.isArray(sync.outputs) && sync.outputs.length ? [...sync.outputs] : [sync] };
}

/**
 * Durable, credit-metered AI media tasks on top of @zucker-framework/task.
 *
 * State machine (durable status / ai_tasks.holdState). No lease or worker slot is held while the
 * provider works: each poll is a short run, and the row waits QUEUED with availableAt = nextPollAt
 * (projected to owners as WAITING_PROVIDER once the provider task id is stored).
 *   submit            -> QUEUED / HELD (or NONE when free), task + outbox + hold in the caller's transaction
 *   claim             -> PROCESSING (attempt lease)
 *   provider accepted -> providerTaskId + nextPollAt stored, PROCESSING -> RETRYING -> QUEUED(availableAt=nextPollAt), fenced
 *   due poll run      -> claim, one status poll (or a stored verified callback outcome), defer again with backoff
 *   success           -> PROCESSING (stage storing) -> outputs re-hosted -> COMPLETED / CONFIRMED (one fenced tx)
 *   failure/timeout   -> FAILED / RELEASED (one fenced tx); deadline and consecutive poll errors are checked per run
 *   cancel            -> CANCELLED / RELEASED (one tx; a racing completion's fenced commit then fails)
 *   lease lost        -> TaskLeaseReconciler requeues; the next run resumes from the stored providerTaskId
 */
export class AITaskService<Tx extends PostgresTaskClient = PostgresTaskClient> {
  readonly store = new PostgresAITaskStore();
  readonly handler: DurableTaskHandler<AITaskPayload, AITaskExecution>;
  private readonly callWrapper: Pick<AICallWrapper, 'callWithRetry'>;
  private readonly fetch: OutputFetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly infraAttempts: number;

  constructor(private readonly options: AITaskServiceOptions<Tx>) {
    this.callWrapper = options.callWrapper ?? new AICallWrapper();
    this.fetch = options.fetch ?? createPublicFetch({ allowedProtocols: ['https:'], allowedPorts: [443] });
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts must be 1..10');
    this.infraAttempts = maxAttempts;
    const outputCount = options.outputLimits?.maxOutputs ?? 4;
    if (!Number.isSafeInteger(outputCount) || outputCount < 1 || outputCount > 16) throw new RangeError('maxOutputs must be 1..16');
    for (const value of Object.values(options.outputLimits?.maxBytes ?? {})) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Output byte limits must be positive integers');
    }
    const downloadTimeout = options.outputLimits?.downloadTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(downloadTimeout) || downloadTimeout < 1 || downloadTimeout > 2_147_000_000)
      throw new RangeError('downloadTimeoutMs must be a positive integer below the timer limit');
    this.handler = {
      execute: (context) => this.execute(context),
      complete: (context, result) => this.complete(context, result),
      fail: (context, error) => this.failAttempt(context, error),
      retry: (context, error, retryAt) => this.retryAttempt(context, error, retryAt),
      onCancelled: (context) => this.releaseIfEnded(context.task.id).then(() => undefined),
    };
  }

  /** Register with the host runtime, e.g. `jobs.registerHandler(aiTasks.registration())`. */
  registration(): AITaskHandlerRegistration {
    return { kind: AI_TASK_DURABLE_KIND, version: AI_TASK_HANDLER_VERSION, handler: this.handler, maxAttempts: this.options.maxAttempts ?? 3 };
  }

  /**
   * Durable attempt budget: every deferred poll run is a claim, so the row allows the failure budget
   * (`maxAttempts`) plus enough poll runs to reach the deadline. Failures are counted separately.
   */
  private durableAttempts(kind: AITaskKind): number {
    const polling = this.options.polling ?? {};
    const maxWait = polling.maxWaitMs?.[kind] ?? DEFAULT_MAX_WAIT_MS[kind];
    const fastest = Math.max(1, Math.min(polling.initialDelayMs ?? 2_000, polling.earlyPollMinIntervalMs ?? 10_000));
    const polls = polling.maxPolls ?? Math.ceil(maxWait / fastest) + 2;
    return Math.min(100_000, this.infraAttempts + Math.max(1, polls) + 1);
  }

  /** Deterministic ids: one task per (owner, idempotency key), never shared across owners. */
  static identity(ownerId: string, idempotencyKey: string): { taskId: string; durableKey: string; holdId: string } {
    const hash = createHash('sha256').update(JSON.stringify(['ai-task', ownerId, idempotencyKey])).digest('hex');
    return { taskId: `ait_${hash}`, durableKey: `ai-task:${hash}`, holdId: `ai-task-hold:${hash}` };
  }

  // ---------------------------------------------------------------- submit / cancel

  /**
   * Validates, prices and writes the durable task, its outbox intent, the ai_tasks row and the credit
   * hold on the caller's transaction. Insufficient credit (thrown by the hold port) rolls all of it
   * back. A replay with the same owner + key + request returns the existing task without a new hold;
   * the same key with a different request throws AITaskIdempotencyConflictError.
   */
  async submit(tx: Tx, input: SubmitAITaskCommand): Promise<SubmitAITaskResult> {
    const command = validateSubmitCommand(structuredClone(input), this.options.inputLimits);
    const requestedCount = command.input.options?.count;
    if (requestedCount !== undefined && (typeof requestedCount !== 'number' || !Number.isSafeInteger(requestedCount)
      || requestedCount < 1 || requestedCount > (this.options.outputLimits?.maxOutputs ?? 4))) throw new AITaskValidationError('options.count');
    const identity = AITaskService.identity(command.ownerId, command.idempotencyKey);
    // The price is not part of the request identity: a replay after a price change returns the original task.
    const fingerprint = createTaskFingerprint({
      ownerId: command.ownerId, kind: command.kind, providerId: command.providerId, model: command.model,
      input: command.input, handlerVersion: AI_TASK_HANDLER_VERSION,
    });
    const replay = await this.replay(tx, identity.taskId, identity.durableKey, fingerprint);
    if (replay) return replay;
    const cost = validateCost(await this.options.costs.resolve({
      ownerId: command.ownerId, kind: command.kind, providerId: command.providerId, model: command.model, input: command.input,
    }));
    if (command.cost !== undefined && command.cost !== cost) throw new AITaskCostChangedError(command.cost, cost);
    const now = this.now();
    const payload: AITaskPayload = {
      v: 1, ownerId: command.ownerId, kind: command.kind, providerId: command.providerId, model: command.model, input: command.input, cost,
    };
    const holdId = cost > 0 ? identity.holdId : null;
    const submitter = new PostgresTaskSubmitter<AITaskPayload, unknown, { taskId: string }>({ runInTransaction: (work) => work(tx) });
    try {
      const result = await submitter.submit({
        task: {
          id: identity.taskId,
          kind: AI_TASK_DURABLE_KIND,
          resource: { type: AI_TASK_RESOURCE_TYPE, id: identity.taskId },
          userId: command.ownerId,
          idempotencyKey: identity.durableKey,
          idempotencyFingerprint: fingerprint,
          handlerVersion: AI_TASK_HANDLER_VERSION,
          payload,
          maxAttempts: this.durableAttempts(command.kind),
          now,
        },
        outbox: { id: `ai-task:${identity.taskId}`, topic: AI_TASK_OUTBOX_TOPIC, payload: { taskId: identity.taskId } },
      }, {
        transactionalWork: async (_client, submitted) => {
          // A replay (created=false) already owns its row and hold; never place a second hold.
          if (!submitted.task.created) return;
          const maxWait = this.options.polling?.maxWaitMs?.[command.kind] ?? DEFAULT_MAX_WAIT_MS[command.kind];
          const inserted = await this.store.insert(tx, {
            id: identity.taskId, ownerId: command.ownerId, kind: command.kind, providerId: command.providerId, model: command.model,
            cost, holdId, holdState: holdId ? 'HELD' : 'NONE', providerTaskId: null, pollCount: 0, pollErrors: 0, deferrals: 0, nextPollAt: null,
            wakeRequestedAt: null, deadlineAt: new Date(now.getTime() + maxWait), callbackOutcome: null, createdAt: now, updatedAt: now,
          });
          if (!inserted) throw new Error('AI task row already exists for a newly created durable task');
          if (holdId) {
            await this.options.holds.place(tx, {
              holdId, ownerId: command.ownerId, amount: cost, taskId: identity.taskId, operationKey: `ai-task:${identity.taskId}:hold`,
            });
          }
        },
      });
      const row = await this.store.find(tx, identity.taskId);
      if (!row) throw new Error('AI task row is missing after submission');
      const outputs = result.task.created ? undefined : (await this.store.outputs(tx, [identity.taskId])).get(identity.taskId);
      return { task: toView(row, outputs), created: result.task.created };
    } catch (error) {
      if (error instanceof TaskIdempotencyConflictError) throw new AITaskIdempotencyConflictError();
      throw error;
    }
  }

  private async replay(tx: Tx, taskId: string, durableKey: string, fingerprint: string): Promise<SubmitAITaskResult | null> {
    const existing = await new PostgresTaskRepository(tx).findByIdempotencyKey(durableKey);
    if (!existing) return null;
    if (existing.idempotencyFingerprint !== fingerprint || existing.id !== taskId) throw new AITaskIdempotencyConflictError();
    const row = await this.store.find(tx, taskId);
    if (!row) throw new Error('AI task row is missing for an existing durable task');
    return { task: toView(row, (await this.store.outputs(tx, [taskId])).get(taskId)), created: false };
  }

  /** `submit` in its own transaction followed by a wake hint. */
  async submitAndWake(command: SubmitAITaskCommand): Promise<SubmitAITaskResult> {
    const result = await this.options.transactions.runInTransaction((tx) => this.submit(tx, command));
    this.options.wake?.(result.task.id);
    return result;
  }

  /**
   * Owner cancellation on the caller's transaction: CANCELLED plus hold release in one commit.
   * Returns null for unknown/foreign ids (respond 404). Terminal tasks are returned unchanged.
   */
  async cancel(tx: Tx, ownerId: string, taskId: string): Promise<AITaskView | null> {
    const existing = await this.store.findOwned(tx, ownerId, taskId);
    if (!existing) return null;
    if (!isTerminalTaskStatus(existing.status)) {
      // Lock order everywhere (see PostgresAITaskStore): async_jobs first, then ai_tasks, then the ledger.
      const cancelled = await new PostgresTaskRepository(tx).cancel(taskId, this.now());
      if (cancelled) {
        await this.store.clearGeneratedOutputs(tx, taskId);
        await this.settleHold(tx, taskId, 'RELEASED', 'cancelled');
      }
    }
    const row = await this.store.find(tx, taskId);
    return row ? toView(row, (await this.store.outputs(tx, [taskId])).get(taskId)) : null;
  }

  /** `cancel` in its own transaction, then wakes a local waiter so it stops promptly. */
  async cancelOwned(ownerId: string, taskId: string): Promise<AITaskView | null> {
    const view = await this.options.transactions.runInTransaction((tx) => this.cancel(tx, ownerId, taskId));
    if (view) this.notify(taskId);
    return view;
  }

  // ---------------------------------------------------------------- callbacks

  /**
   * Provider callback entry (raw body, headers). Only a verifier-accepted callback can record an
   * outcome; it is stored once (first wins) and settled by the lease owner, so duplicates settle once.
   * An unverified callback can at most move the next poll forward (rate-limited) and never changes
   * status, results or holds.
   */
  async handleCallback(
    providerId: string,
    rawBody: Uint8Array | string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<AITaskCallbackResult> {
    const verifier = this.options.callbacks?.resolve(providerId);
    if (!verifier) return { providerKnown: false, verified: false, action: 'none' };
    let verified: Awaited<ReturnType<typeof verifier.verify>> = null;
    try {
      verified = await verifier.verify(rawBody, headers);
    } catch {
      verified = null;
    }
    const now = this.now();
    if (verified && typeof verified.providerTaskId === 'string' && PROVIDER_TASK_ID.test(verified.providerTaskId)) {
      const outcome = this.callbackOutcome(verified.task);
      const taskId = await this.options.transactions.runInTransaction((tx) =>
        this.store.recordCallbackOutcome(tx, providerId, verified.providerTaskId, outcome, now));
      if (taskId) this.wakeTask(taskId);
      return { providerKnown: true, verified: true, action: taskId ? 'recorded' : 'none' };
    }
    let hint: string | null = null;
    try {
      hint = verifier.hint?.(rawBody, headers) ?? null;
    } catch {
      hint = null;
    }
    if (typeof hint === 'string' && PROVIDER_TASK_ID.test(hint)) {
      const minInterval = this.options.polling?.earlyPollMinIntervalMs ?? 10_000;
      const taskId = await this.options.transactions.runInTransaction((tx) =>
        this.store.requestEarlyPoll(tx, providerId, hint as string, now, minInterval));
      if (taskId) this.wakeTask(taskId);
      return { providerKnown: true, verified: false, action: taskId ? 'poll-scheduled' : 'none' };
    }
    return { providerKnown: true, verified: false, action: 'none' };
  }

  private callbackOutcome(task: AIMediaTaskLike | undefined): StoredCallbackOutcome | null {
    if (!task) return null;
    const outcome = normalizeProviderResult(task);
    if (outcome.state === 'failed') return { state: 'failed' };
    if (outcome.state !== 'succeeded') return null;
    const maxOutputs = this.options.outputLimits?.maxOutputs ?? 4;
    const urls = outcome.outputs.slice(0, maxOutputs).map((output) => output?.url);
    // Inline (base64) or malformed outputs are not persisted from a callback; the poll fetches them.
    if (!urls.length || urls.some((url) => typeof url !== 'string' || url.length > 4096)) return null;
    return { state: 'succeeded', outputs: (urls as string[]).map((url) => ({ url })) };
  }

  // ---------------------------------------------------------------- readers

  async get(ownerId: string, taskId: string): Promise<AITaskView | null> {
    return this.options.transactions.runInTransaction(async (tx) => {
      const row = await this.store.findOwned(tx, ownerId, taskId);
      return row ? toView(row, (await this.store.outputs(tx, [taskId])).get(taskId)) : null;
    });
  }

  async list(ownerId: string, input: ListAITasksInput = {}): Promise<AITaskPage<AITaskView>> {
    return this.page({ ...input, ownerId }, (row, outputs) => toView(row, outputs));
  }

  /** Management projection (all owners, prompt truncated, no provider payload). */
  async listForManagement(input: ListAITasksInput & { ownerId?: string; promptLimit?: number } = {}): Promise<AITaskPage<AITaskManagementView>> {
    const promptLimit = input.promptLimit ?? 200;
    return this.page(input, (row, outputs) => toManagementView(row, outputs, promptLimit));
  }

  async getForManagement(taskId: string, promptLimit = 200): Promise<AITaskManagementView | null> {
    return this.options.transactions.runInTransaction(async (tx) => {
      const row = await this.store.find(tx, taskId);
      return row ? toManagementView(row, (await this.store.outputs(tx, [taskId])).get(taskId), promptLimit) : null;
    });
  }

  /** Server-side output lookup for a download ticket; only for the owner's COMPLETED task. */
  async findOutput(ownerId: string, taskId: string, index: number): Promise<AITaskStoredOutput | null> {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    return this.options.transactions.runInTransaction(async (tx) => {
      const row = await this.store.findOwned(tx, ownerId, taskId);
      if (!row || row.status !== 'COMPLETED') return null;
      return (await this.store.outputs(tx, [taskId])).get(taskId)?.find((output) => output.index === index) ?? null;
    });
  }

  private async page<T>(
    input: ListAITasksInput & { ownerId?: string },
    project: (row: AITaskJoinedRow, outputs: AITaskStoredOutput[] | undefined) => T,
  ): Promise<AITaskPage<T>> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)));
    return this.options.transactions.runInTransaction(async (tx) => {
      const rows = await this.store.list(tx, { ownerId: input.ownerId, kind: input.kind, status: input.status, before: input.before, limit: limit + 1 });
      const visible = rows.slice(0, limit);
      const outputs = await this.store.outputs(tx, visible.filter((row) => row.status === 'COMPLETED').map((row) => row.id));
      const last = visible[visible.length - 1];
      return {
        items: visible.map((row) => project(row, outputs.get(row.id))),
        next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }

  // ---------------------------------------------------------------- maintenance

  /**
   * Releases holds of tasks that ended outside this handler (lease recovery after the last attempt,
   * unsupported-kind failure, a direct repository cancel). Register as a host wake source.
   */
  async reconcileHolds(limit = 50): Promise<number> {
    const ids = await this.options.transactions.runInTransaction((tx) => this.store.findOrphanedHolds(tx, limit));
    let released = 0;
    for (const id of ids) {
      try {
        if (await this.releaseIfEnded(id)) released += 1;
      } catch {
        this.options.logger?.warn?.('ai_task_hold_reconcile_failed', { taskId: id });
      }
    }
    return released;
  }

  private async releaseIfEnded(taskId: string): Promise<boolean> {
    return this.options.transactions.runInTransaction(async (tx) => {
      const row = await this.store.find(tx, taskId);
      if (!row || (row.status !== 'FAILED' && row.status !== 'CANCELLED')) return false;
      await this.store.lockJob(tx, taskId);
      await this.store.clearGeneratedOutputs(tx, taskId);
      return this.settleHold(tx, taskId, 'RELEASED', row.status === 'CANCELLED' ? 'cancelled' : 'failed');
    });
  }

  /** HELD -> CONFIRMED/RELEASED exactly once; the CAS and the ledger movement share the transaction. */
  private async settleHold(tx: Tx, taskId: string, to: 'CONFIRMED' | 'RELEASED', reason: 'failed' | 'cancelled' | 'timeout'): Promise<boolean> {
    // Lock order (see PostgresAITaskStore): async_jobs, then ai_tasks, then the ledger. Callers that
    // already transitioned async_jobs hold its lock; re-locking in the same transaction is a no-op.
    await this.store.lockJob(tx, taskId);
    const row = await this.store.find(tx, taskId, true);
    if (!row?.holdId || row.holdState !== 'HELD') return false;
    if (!(await this.store.settleHoldState(tx, taskId, to, this.now()))) return false;
    const settlement = { holdId: row.holdId, ownerId: row.ownerId, taskId };
    if (to === 'CONFIRMED') await this.options.holds.confirm(tx, { ...settlement, operationKey: `ai-task:${taskId}:confirm` });
    else await this.options.holds.release(tx, { ...settlement, operationKey: `ai-task:${taskId}:release`, reason });
    return true;
  }

  // ---------------------------------------------------------------- worker

  private async execute(context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>): Promise<AITaskExecution> {
    const taskId = context.task.id;
    try {
      const row = await this.read(taskId);
      if (!row) throw fatal.stateMissing();
      if (row.status !== 'PROCESSING') throw new AITaskStoppedError(taskId);
      // Runs that ended by scheduling the next poll are not failures; everything else counts.
      if (context.task.attempt - 1 - row.deferrals >= this.infraAttempts) throw fatal.attemptsExhausted();
      // STORED is a settlement retry, independent of provider availability or its expired URLs.
      if (row.executionState === 'STORED') {
        const outputs = await this.options.transactions.runInTransaction(async tx => (await this.store.outputs(tx, [taskId])).get(taskId) ?? []);
        if (!outputs.length) throw fatal.stateMissing();
        return { outputs };
      }
      if (row.executionState !== 'GENERATED' && this.now().getTime() >= row.deadlineAt.getTime()) throw fatal.timeout();

      let outcome: ProviderOutcome | undefined = row.generatedOutputs
        ? { state: 'succeeded', outputs: row.generatedOutputs }
        : row.callbackOutcome
        ? (row.callbackOutcome.state === 'failed' ? { state: 'failed' } : { state: 'succeeded', outputs: row.callbackOutcome.outputs })
        : undefined;
      if (!outcome) {
        const { provider, config } = await this.resolveProvider(row);
        if (!row.providerTaskId) {
          if (row.executionState === 'SUBMITTING') {
            // A prior process may have paid the provider. Recover by the stable task identity; a
            // missing response or lost DB acknowledgement is never permission to submit again.
            const recover = this.options.providers.recoverSubmission;
            if (!recover) throw fatal.submissionUnknown();
            const recovered = await this.callWrapper.callWithRetry(({ signal }) => recover.call(this.options.providers, {
              taskId: row.id, ownerId: row.ownerId, kind: row.kind, providerId: row.providerId,
              model: row.model, input: row.payload.input,
            }, signal), { maxAttempts: 1, timeoutMs: this.options.pollTimeoutMs ?? 30_000, signal: context.signal });
            if (!recovered) return await this.deferRun(context, row, { pollCount: row.pollCount + 1, pollErrors: 0 });
            outcome = normalizeProviderResult(recovered);
          } else {
            await context.reportProgress('submitting', 5);
            await this.checkpoint(context, { state: 'SUBMITTING' });
            outcome = await this.submitToProvider(context, provider, row.payload.input.prompt, config);
          }
          if (outcome.state === 'pending') {
            if (!outcome.providerTaskId || !PROVIDER_TASK_ID.test(outcome.providerTaskId) || !provider.getTaskStatus) throw fatal.unsupported();
            await this.checkpoint(context, { state: 'ACCEPTED', providerTaskId: outcome.providerTaskId });
            // Persisting the provider task id with the deferral means a later run polls, never submits again.
            return await this.deferRun(context, row, { providerTaskId: outcome.providerTaskId, pollCount: 0, pollErrors: 0, progress: 10 });
          }
        } else {
          const now = this.now();
          // Woken before the poll is due (e.g. lease recovery requeued it): reschedule without polling.
          if (row.nextPollAt && row.nextPollAt.getTime() > now.getTime()) {
            return await this.deferRun(context, row, { nextPollAt: row.nextPollAt, pollCount: row.pollCount, pollErrors: row.pollErrors });
          }
          if (!provider.getTaskStatus) throw fatal.unsupported();
          try {
            const status = await this.callWrapper.callWithRetry(
              ({ signal }) => provider.getTaskStatus!(row.providerTaskId!, { ...config, signal } as MediaGenerationConfig),
              { maxAttempts: 1, retryTimeouts: false, timeoutMs: this.options.pollTimeoutMs ?? 30_000, signal: context.signal,
                context: `ai-task poll [${provider.id}]` },
            );
            outcome = normalizeProviderResult(status);
          } catch (error) {
            if (context.signal.aborted) throw error;
            const pollErrors = row.pollErrors + 1;
            this.options.logger?.warn?.('ai_task_poll_failed', { taskId, consecutiveErrors: pollErrors });
            if (pollErrors >= (this.options.polling?.maxConsecutivePollErrors ?? 5)) throw fatal.unreachable();
            return await this.deferRun(context, row, { pollCount: row.pollCount + 1, pollErrors });
          }
          if (outcome.state === 'pending') {
            const progress = outcome.progress === undefined ? undefined : Math.round(10 + Math.max(0, Math.min(100, outcome.progress)) * 0.7);
            return await this.deferRun(context, row, { pollCount: row.pollCount + 1, pollErrors: 0, progress });
          }
        }
      }
      if (outcome.state !== 'succeeded') throw fatal.failed();
      const outputs = this.snapshotOutputs(row, outcome.outputs);
      if (row.executionState !== 'GENERATED') await this.checkpoint(context, { state: 'GENERATED', outputs });
      await context.reportProgress('storing', 90);
      const stored = await this.rehost(context, row, outputs, true);
      await this.checkpoint(context, { state: 'STORED', stored });
      return { outputs: stored };
    } catch (error) {
      if (context.signal.aborted || error instanceof DurableTaskRetryScheduledError || error instanceof AITaskStoppedError
        || error instanceof DurableTaskLeaseLostError) throw error;
      if (error instanceof AITaskFatalError) {
        await this.failNow(context, error.toSummary());
      } else {
        // Infrastructure error: the host retries it, unless this task already used its failure budget.
        const latest = await this.read(taskId).catch(() => null);
        if (latest && context.task.attempt - latest.deferrals >= this.infraAttempts) {
          await this.failNow(context, fatal.attemptsExhausted().toSummary());
        }
      }
      throw error;
    }
  }

  /** Persist only bounded result bytes/URLs, never provider metadata or credentials. */
  private snapshotOutputs(row: AITaskJoinedRow, outputs: readonly AIMediaResultLike[]): AIMediaResultLike[] {
    const maximum = this.options.outputLimits?.maxOutputs ?? 4;
    const count = row.payload.input.options?.count;
    if (typeof count === 'number' && (outputs.length !== count || count > maximum)) throw fatal.outputCount();
    const selected = outputs.slice(0, maximum);
    if (!selected.length) throw fatal.outputMissing();
    const maxBytes = this.options.outputLimits?.maxBytes?.[row.kind] ?? DEFAULT_MAX_BYTES[row.kind];
    return selected.map(output => {
      if (typeof output?.url === 'string' && output.url && output.url.length <= 4096) return { url: output.url };
      if (typeof output?.base64 === 'string' && output.base64 && output.base64.length <= Math.ceil(maxBytes / 3) * 4 + 128)
        return { base64: output.base64 };
      throw fatal.outputRejected();
    });
  }

  private async checkpoint(context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>,
    input: Pick<Parameters<PostgresAITaskStore['checkpoint']>[1], 'state' | 'providerTaskId' | 'outputs' | 'stored'>): Promise<void> {
    // Retry writing an already obtained provider answer, not the provider call. This also tolerates
    // a committed write whose acknowledgement was lost (all checkpoints except NEW->SUBMITTING are idempotent).
    const attempts = input.state === 'SUBMITTING' ? 1 : 3;
    for (let attempt = 1; ; attempt += 1) {
      context.signal.throwIfAborted();
      try {
        const saved = await this.options.transactions.runInTransaction(tx => this.store.checkpoint(tx, {
          id: context.task.id, leaseToken: context.leaseToken, now: this.now(), ...input,
        }));
        if (!saved) throw new DurableTaskLeaseLostError(context.task.id, 'execution checkpoint');
        return;
      } catch (error) {
        if (context.signal.aborted || error instanceof DurableTaskLeaseLostError || attempt >= attempts) throw error;
        await this.sleep(100 * attempt, context.signal);
      }
    }
  }

  private async resolveProvider(row: AITaskJoinedRow): Promise<{ provider: AITaskMediaProvider; config: Record<string, unknown> }> {
    let resolved: Awaited<ReturnType<AITaskProviderResolver['resolve']>>;
    try {
      resolved = await this.options.providers.resolve({
        taskId: row.id, ownerId: row.ownerId, kind: row.kind, providerId: row.providerId, model: row.model, input: row.payload.input,
      });
    } catch {
      throw fatal.providerUnavailable();
    }
    const provider = resolved?.provider;
    if (!provider || !provider.supportedTypes.some((type) => String(type).toLowerCase() === row.kind)) throw fatal.unsupported();
    // Server-trusted configuration wins over caller options; the model comes from the stored task.
    return { provider, config: { ...(row.payload.input.options ?? {}), ...resolved.config, modelId: row.model, clientRequestId: row.id } };
  }

  /**
   * Ends this run without keeping the lease or a worker slot: persists the poll state and requeues the
   * durable row at nextPollAt (PROCESSING -> RETRYING -> QUEUED, one transaction fenced by the lease),
   * then signals the runtime through DurableTaskRetryScheduledError. The host's queue reconciler (or a
   * wake hint) runs it again when due.
   */
  private async deferRun(
    context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>,
    row: AITaskJoinedRow,
    input: { nextPollAt?: Date; providerTaskId?: string; pollCount: number; pollErrors: number; progress?: number },
  ): Promise<never> {
    const now = this.now();
    const nextPollAt = input.nextPollAt ?? new Date(Math.min(
      now.getTime() + pollDelayMs(input.pollCount, this.options.polling), row.deadlineAt.getTime()));
    const deferred = await this.options.transactions.runInTransaction((tx) => this.store.defer(tx, {
      id: row.id, leaseToken: context.leaseToken, now, nextPollAt, providerTaskId: input.providerTaskId,
      pollCount: input.pollCount, pollErrors: input.pollErrors, stage: 'waiting', progress: input.progress,
    }));
    if (!deferred) {
      const latest = await this.read(row.id);
      if (latest && isTerminalTaskStatus(latest.status)) throw new AITaskStoppedError(row.id);
      throw new DurableTaskLeaseLostError(row.id, 'poll deferral');
    }
    this.scheduleWake(row.id, nextPollAt.getTime() - now.getTime());
    throw new DurableTaskRetryScheduledError(row.id, {
      code: 'AI_PROVIDER_PENDING', category: 'UNKNOWN', summary: 'Waiting for the AI provider', retryable: true,
    }, nextPollAt);
  }

  /** Optional in-process timer so a due poll does not wait for the next host scan; durable state stays authoritative. */
  private scheduleWake(taskId: string, delayMs: number): void {
    if (!this.options.wake) return;
    const timer = setTimeout(() => this.notify(taskId), Math.max(0, delayMs));
    timer.unref?.();
  }

  private async submitToProvider(
    context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>,
    provider: AITaskMediaProvider,
    prompt: string,
    config: Record<string, unknown>,
  ): Promise<ProviderOutcome> {
    try {
      const result = await this.callWrapper.callWithRetry(
        ({ signal }) => provider.generate(prompt, { ...config, signal } as MediaGenerationConfig),
        {
          // Submission is billed by the provider and not idempotent: never retried automatically.
          maxAttempts: 1, retryTimeouts: false, timeoutMs: this.options.submitTimeoutMs ?? 120_000,
          signal: context.signal, context: `ai-task submit [${provider.id}]`,
        },
      );
      return normalizeProviderResult(result);
    } catch (error) {
      if (context.signal.aborted) throw error;
      const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
      // An explicit client refusal is terminal. Transport/5xx failures may hide an accepted paid
      // request: a subsequent durable attempt can query recoverSubmission, never generate again.
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) throw fatal.rejected();
      if (!this.options.providers.recoverSubmission) throw fatal.submissionUnknown();
      throw error;
    }
  }

  private async rehost(
    context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>,
    row: AITaskJoinedRow,
    outputs: readonly AIMediaResultLike[],
    resumable: boolean,
  ): Promise<AITaskStoredOutput[]> {
    const limits = this.options.outputLimits ?? {};
    const selected = outputs.slice(0, limits.maxOutputs ?? 4);
    if (!selected.length) throw fatal.outputMissing();
    const maxBytes = limits.maxBytes?.[row.kind] ?? DEFAULT_MAX_BYTES[row.kind];
    const allowed = limits.contentTypes?.[row.kind] ?? DEFAULT_AI_OUTPUT_CONTENT_TYPES[row.kind];
    const attempts = Math.max(1, limits.downloadAttempts ?? 3);
    const stored: AITaskStoredOutput[] = [];
    const previous = await this.options.transactions.runInTransaction(async tx => (await this.store.outputs(tx, [row.id])).get(row.id) ?? []);
    for (const [index, output] of selected.entries()) {
      const existing = previous.find(item => item.index === index);
      if (existing) { stored.push(existing); continue; }
      const value = await this.withOutputDeadline(context, async bounded => {
        const download = { fetch: this.fetch, maxBytes, allowedContentTypes: allowed, signal: bounded.signal };
        const putStream = this.options.outputs.putStream?.bind(this.options.outputs);
        return putStream
          ? this.rehostStreaming(bounded, row, index, output, download, attempts, resumable, putStream)
          : this.rehostBuffered(bounded, row, index, output, download, attempts, resumable);
      });
      await this.checkpoint(context, { state: 'GENERATED', stored: [value] });
      stored.push(value);
    }
    return stored;
  }

  private async withOutputDeadline<T>(context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>,
    work: (bounded: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(fatal.outputTimeout()), this.options.outputLimits?.downloadTimeoutMs ?? 120_000);
    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      // Subscribe before starting user-supplied transports/stores: they may synchronously abort the host.
      return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work({ ...context, signal }); }), aborted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Storage failure policy shared by both paths. */
  private storageFailure(error: unknown, resumable: boolean): never {
    if (error instanceof AITaskOutputRejectedError || (error instanceof Error && error.name === 'AITaskOutputRejectedError')) {
      throw (error as AITaskOutputRejectedError).reason === 'quota' ? fatal.outputQuota() : fatal.outputRejected();
    }
    // With a stored provider task id a retried attempt can poll and store again; a synchronous
    // result cannot be recovered without generating again, so it fails (and releases) instead.
    if (resumable) throw error;
    throw fatal.storageFailed();
  }

  private async rehostBuffered(
    context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>, row: AITaskJoinedRow, index: number,
    output: AIMediaResultLike, download: Parameters<typeof downloadOutput>[1], attempts: number, resumable: boolean,
  ): Promise<AITaskStoredOutput> {
    let downloaded: Awaited<ReturnType<typeof downloadOutput>> | undefined;
    for (let attempt = 1; !downloaded; attempt += 1) {
      try {
        downloaded = await downloadOutput(output, download);
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (isOutboundRejection(error)) throw fatal.outputRejected();
        if (attempt >= attempts) throw fatal.outputUnavailable();
        await this.sleep(1_000 * attempt, context.signal);
      }
    }
    await context.assertActive();
    context.signal.throwIfAborted();
    try {
      const { storageKey } = await this.options.outputs.put({
        taskId: row.id, ownerId: row.ownerId, kind: row.kind, index, body: downloaded.body,
        contentType: downloaded.contentType, sha256: downloaded.sha256, bytes: downloaded.bytes, signal: context.signal,
      });
      if (typeof storageKey !== 'string' || !storageKey) throw new Error('Output store returned no key');
      return { taskId: row.id, index, storageKey, contentType: downloaded.contentType, bytes: downloaded.bytes, sha256: downloaded.sha256 };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return this.storageFailure(error, resumable);
    }
  }

  /**
   * Streams the provider output into the store: type sniffed from the first bytes, hashed and capped
   * while flowing; the store removes a partial object when the stream or the write fails. A transport
   * error of the source is retried (bounded); a cap/type rejection fails the task.
   */
  private async rehostStreaming(
    context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>, row: AITaskJoinedRow, index: number,
    output: AIMediaResultLike, download: Parameters<typeof openOutput>[1], attempts: number, resumable: boolean,
    putStream: NonNullable<OutputStorePort['putStream']>,
  ): Promise<AITaskStoredOutput> {
    for (let attempt = 1; ; attempt += 1) {
      let opened: OpenedOutput;
      try {
        opened = await openOutput(output, download);
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (isOutboundRejection(error)) throw fatal.outputRejected();
        if (attempt >= attempts) throw fatal.outputUnavailable();
        await this.sleep(1_000 * attempt, context.signal);
        continue;
      }
      try {
        await context.assertActive();
        context.signal.throwIfAborted();
        const result = await putStream({
          taskId: row.id, ownerId: row.ownerId, kind: row.kind, index, contentType: opened.contentType,
          maxBytes: download.maxBytes, stream: opened.stream, signal: context.signal,
        });
        const digest = opened.digest();
        if (typeof result?.storageKey !== 'string' || !result.storageKey || !Number.isSafeInteger(result.bytes) || result.bytes < 1
          || result.bytes > download.maxBytes || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256))
          throw new Error('Output store returned an invalid object');
        // A store may reuse the object it already has for (taskId, index) without reading the stream.
        if (digest.complete && (digest.sha256 !== result.sha256 || digest.bytes !== result.bytes))
          throw new Error('Stored output does not match the download');
        await opened.cancel();
        return { taskId: row.id, index, storageKey: result.storageKey, contentType: opened.contentType, bytes: result.bytes, sha256: result.sha256 };
      } catch (error) {
        await opened.cancel();
        if (context.signal.aborted) throw error;
        if (opened.rejection()) throw fatal.outputRejected();
        if (opened.sourceError() !== undefined) {
          if (attempt >= attempts) throw fatal.outputUnavailable();
          await this.sleep(1_000 * attempt, context.signal);
          continue;
        }
        return this.storageFailure(error, resumable);
      }
    }
  }

  /** Terminal success, output rows and hold confirmation in one transaction fenced by the lease. */
  private async complete(context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>, result: AITaskExecution): Promise<boolean> {
    return this.options.transactions.runInTransaction(async (tx) => {
      const now = this.now();
      const completed = await new PostgresTaskRepository(tx).transition({
        id: context.task.id, from: 'PROCESSING', to: 'COMPLETED', leaseToken: context.leaseToken,
        stage: 'completed', result: { outputs: result.outputs.length }, now,
      });
      if (!completed) return false;
      await this.store.insertOutputs(tx, result.outputs, now);
      await this.settleHold(tx, context.task.id, 'CONFIRMED', 'failed');
      return true;
    });
  }

  /** Terminal failure and hold release in one transaction fenced by the lease (from PROCESSING or WAITING_PROVIDER). */
  private async failAttempt(context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>, error: TaskErrorSummary): Promise<boolean> {
    return this.failNow(context, error);
  }

  private async failNow(context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>, error: TaskErrorSummary): Promise<boolean> {
    return this.options.transactions.runInTransaction(async (tx) => {
      const repository = new PostgresTaskRepository(tx);
      const current = await repository.findById(context.task.id);
      if (!current || (current.status !== 'PROCESSING' && current.status !== 'WAITING_PROVIDER')) return false;
      const failed = await repository.transition({
        id: context.task.id, from: current.status, to: 'FAILED', leaseToken: context.leaseToken, error, now: this.now(),
      });
      if (!failed) return false;
      await this.store.clearGeneratedOutputs(tx, context.task.id);
      await this.settleHold(tx, context.task.id, 'RELEASED', error.code === 'AI_PROVIDER_TIMEOUT' ? 'timeout' : 'failed');
      return true;
    });
  }

  /** Retry from either leased state; the hold stays HELD and the next attempt resumes. */
  private async retryAttempt(
    context: DurableTaskAttemptContext<AITaskPayload, AITaskExecution>, error: TaskErrorSummary, retryAt: Date,
  ): Promise<boolean> {
    const repository = new PostgresTaskRepository<AITaskPayload, unknown>({ query: (sql, values) =>
      this.options.transactions.runInTransaction((tx) => tx.query(sql, values)) });
    const current = await repository.findById(context.task.id);
    if (!current || (current.status !== 'PROCESSING' && current.status !== 'WAITING_PROVIDER')) return false;
    const retrying = await repository.transition({
      id: context.task.id, from: current.status, to: 'RETRYING', leaseToken: context.leaseToken, error, availableAt: retryAt, now: this.now(),
    });
    if (!retrying) return false;
    try {
      await repository.transition({ id: context.task.id, from: 'RETRYING', to: 'QUEUED', error, availableAt: retryAt, now: this.now() });
    } catch {
      // RETRYING rows are requeued by TaskQueueReconciler once availableAt passes.
    }
    return true;
  }

  private read(taskId: string): Promise<AITaskJoinedRow | null> {
    return this.options.transactions.runInTransaction((tx) => this.store.find(tx, taskId));
  }

  /** Wake hint for a task (forwards to the host's `wake`); durable scheduling stays authoritative. */
  notify(taskId: string): void {
    try {
      this.options.wake?.(taskId);
    } catch {
      this.options.logger?.warn?.('ai_task_wake_failed', { taskId });
    }
  }

  private wakeTask(taskId: string): void {
    this.notify(taskId);
  }
}
