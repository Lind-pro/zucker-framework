import { PostgresTaskOutboxRepository } from './postgres-task-outbox';
import { PostgresTaskRepository, type PostgresTaskClient } from './postgres-task-repository';
import type { CreateTaskInput, CreateTaskResult } from './task-repository';
import type { TaskOutboxRecord } from './task-outbox';

export interface PostgresTaskTransactionRunner {
  runInTransaction<T>(work: (client: PostgresTaskClient) => Promise<T>): Promise<T>;
}

export interface SubmitTaskOutboxInput<TPayload> {
  id: string;
  topic: string;
  payload: TPayload;
  availableAt?: Date;
}

export interface SubmitTaskInput<TTaskPayload, TOutboxPayload> {
  task: CreateTaskInput<TTaskPayload>;
  outbox: SubmitTaskOutboxInput<TOutboxPayload>;
}

export interface SubmitTaskResult<TTaskPayload, TTaskResult, TOutboxPayload> {
  task: CreateTaskResult<TTaskPayload, TTaskResult>;
  outbox: {
    record: TaskOutboxRecord<TOutboxPayload>;
    created: boolean;
  };
}

export interface SubmitTaskOptions<TTaskPayload, TTaskResult, TOutboxPayload> {
  /**
   * Persists an application-owned projection in the same transaction as the
   * durable task and outbox intent. The callback can run again for an
   * idempotent submission, so application writes must also be idempotent.
   */
  transactionalWork?: (
    client: PostgresTaskClient,
    result: SubmitTaskResult<TTaskPayload, TTaskResult, TOutboxPayload>,
  ) => Promise<void>;
}

export interface SubmitTaskBatchOptions<TTaskPayload, TTaskResult, TOutboxPayload> {
  /**
   * Persists application-owned batch projections in the same transaction as
   * every task and outbox intent. The callback receives results in input order
   * and must remain idempotent when a batch is submitted again.
   */
  transactionalWork?: (
    client: PostgresTaskClient,
    results: SubmitTaskResult<TTaskPayload, TTaskResult, TOutboxPayload>[],
  ) => Promise<void>;
}

/** Creates the durable task and its queue intent in one database transaction. */
export class PostgresTaskSubmitter<
  TTaskPayload = unknown,
  TTaskResult = unknown,
  TOutboxPayload = unknown,
> {
  constructor(private readonly transactions: PostgresTaskTransactionRunner) {}

  async submit(
    input: SubmitTaskInput<TTaskPayload, TOutboxPayload>,
    options: SubmitTaskOptions<TTaskPayload, TTaskResult, TOutboxPayload> = {},
  ): Promise<SubmitTaskResult<TTaskPayload, TTaskResult, TOutboxPayload>> {
    return this.transactions.runInTransaction(async (client) => {
      const result = await this.submitWithClient(client, input);
      await options.transactionalWork?.(client, result);
      return result;
    });
  }

  async submitBatch(
    inputs: readonly SubmitTaskInput<TTaskPayload, TOutboxPayload>[],
    options: SubmitTaskBatchOptions<TTaskPayload, TTaskResult, TOutboxPayload> = {},
  ): Promise<SubmitTaskResult<TTaskPayload, TTaskResult, TOutboxPayload>[]> {
    return this.transactions.runInTransaction(async (client) => {
      const results: SubmitTaskResult<TTaskPayload, TTaskResult, TOutboxPayload>[] = [];
      for (const input of inputs) {
        results.push(await this.submitWithClient(client, input));
      }
      await options.transactionalWork?.(client, results);
      return results;
    });
  }

  private async submitWithClient(
    client: PostgresTaskClient,
    input: SubmitTaskInput<TTaskPayload, TOutboxPayload>,
  ): Promise<SubmitTaskResult<TTaskPayload, TTaskResult, TOutboxPayload>> {
    const tasks = new PostgresTaskRepository<TTaskPayload, TTaskResult>(client);
    const outbox = new PostgresTaskOutboxRepository<TOutboxPayload>(client);
    const task = await tasks.create(input.task);
    const event = await outbox.append({
      ...input.outbox,
      taskId: task.task.id,
      now: input.task.now,
    });
    return { task, outbox: event };
  }
}
