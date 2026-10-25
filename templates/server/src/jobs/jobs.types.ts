import type { CreateTaskResult, DurableTaskHandler, TaskRecord, TaskResourceRef } from '@zucker-framework/task';
import type { ApplicationTransaction } from '../database';

export interface ApplicationJobTransactionHooks {
  name: string;
  kind: string;
  submitted?(tx: ApplicationTransaction, task: TaskRecord): Promise<void>;
  completed?(tx: ApplicationTransaction, task: TaskRecord): Promise<void>;
  cancelled?(tx: ApplicationTransaction, task: TaskRecord): Promise<void>;
  failed?(tx: ApplicationTransaction, task: TaskRecord): Promise<void>;
}

export interface ApplicationJobRegistration {
  kind: string;
  version: string;
  handler: DurableTaskHandler<unknown, unknown>;
  maxAttempts?: number;
  /** Omit for internal-only jobs. The host never accepts caller-selected ownership. */
  parseUserInput?(context: { ownerId: string; taskId: string }, input: unknown): Promise<{
    payload: unknown;
    resource: TaskResourceRef;
  }>;
}

export interface ApplicationJobCommand {
  kind: string;
  idempotencyKey: string;
  ownerId?: string;
  orderId?: string;
  resource: TaskResourceRef;
  payload: unknown;
  availableAt?: Date;
}

export interface ApplicationJobWakeSource {
  name: string;
  runOnce(): Promise<void>;
}

export type ApplicationJobSubmission = CreateTaskResult<unknown, unknown>;
