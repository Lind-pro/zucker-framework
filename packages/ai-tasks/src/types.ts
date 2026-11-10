import type { PostgresTaskClient, TaskStatus } from '@zucker-framework/task';

export const AI_TASK_KINDS = ['image', 'video', 'audio'] as const;
export type AITaskKind = (typeof AI_TASK_KINDS)[number];

/** Durable task kind registered with the host runtime (`async_jobs.kind`). */
export const AI_TASK_DURABLE_KIND = 'ai.media';
export const AI_TASK_HANDLER_VERSION = '1';
export const AI_TASK_RESOURCE_TYPE = 'ai-task';
export const AI_TASK_OUTBOX_TOPIC = 'ai.task.ready';

export type AITaskOptionValue = string | number | boolean | null | readonly string[];

/** Caller input. The prompt and options are untrusted; they are validated before persistence. */
export interface AITaskInput {
  prompt: string;
  /** Provider generation options (width, count, duration ...). Credential and transport keys are refused. */
  options?: Readonly<Record<string, AITaskOptionValue>>;
  /** Application-owned reference ids (e.g. the caller's own file asset ids), resolved by the provider resolver. */
  references?: readonly string[];
}

export interface SubmitAITaskCommand {
  ownerId: string;
  kind: AITaskKind;
  providerId: string;
  model: string;
  input: AITaskInput;
  /** Stable client key; unique per owner. Same key + same request returns the existing task. */
  idempotencyKey: string;
  /**
   * The price the caller was shown. When given it must equal the resolved cost, so a price change
   * between quote and submit is refused instead of silently charging another amount.
   */
  cost?: number;
}

/** Durable payload stored in `async_jobs.payload` (never contains credentials). */
export interface AITaskPayload {
  v: 1;
  ownerId: string;
  kind: AITaskKind;
  providerId: string;
  model: string;
  input: AITaskInput;
  cost: number;
}

/** Small durable result stored in `async_jobs.result`; output rows live in `ai_task_outputs`. */
export interface AITaskResult {
  outputs: number;
}

export type AITaskHoldState = 'NONE' | 'HELD' | 'CONFIRMED' | 'RELEASED';

export interface AITaskOutputView {
  index: number;
  contentType: string;
  bytes: number;
}

/** Owner-facing projection. Contains no provider task id, raw payload, storage key or hold id. */
export interface AITaskView {
  id: string;
  kind: AITaskKind;
  providerId: string;
  model: string;
  status: TaskStatus;
  stage: string | null;
  progress: number;
  cost: number;
  /** HELD while running; CONFIRMED when charged; RELEASED when refunded; NONE for free tasks. */
  charge: AITaskHoldState;
  prompt: string;
  error: { code: string; summary: string } | null;
  outputs: AITaskOutputView[];
  canCancel: boolean;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/** Management projection: owner id included, prompt truncated, still no provider payload. */
export interface AITaskManagementView extends AITaskView {
  ownerId: string;
  attempt: number;
}

/** Server-side lookup for issuing a download ticket. Never return it to a browser as is. */
export interface AITaskStoredOutput {
  taskId: string;
  index: number;
  storageKey: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface AITaskTransactionRunner<Tx extends PostgresTaskClient> {
  runInTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}
