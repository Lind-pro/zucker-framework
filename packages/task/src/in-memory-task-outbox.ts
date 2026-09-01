import { isDeepStrictEqual } from 'node:util';
import {
  TaskOutboxConflictError,
  type AppendTaskOutboxInput,
  type ClaimTaskOutboxInput,
  type TaskOutboxRecord,
  type TaskOutboxRepository,
} from './task-outbox';

function cloneRecord<TPayload>(record: TaskOutboxRecord<TPayload>): TaskOutboxRecord<TPayload> {
  return {
    ...record,
    availableAt: new Date(record.availableAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    leaseExpiresAt: record.leaseExpiresAt ? new Date(record.leaseExpiresAt) : undefined,
    publishedAt: record.publishedAt ? new Date(record.publishedAt) : undefined,
  };
}

/** Reference outbox for contract tests and local development only. */
export class InMemoryTaskOutboxRepository<
  TPayload = unknown,
> implements TaskOutboxRepository<TPayload> {
  private readonly records = new Map<string, TaskOutboxRecord<TPayload>>();

  async append(input: AppendTaskOutboxInput<TPayload>): Promise<{
    record: TaskOutboxRecord<TPayload>;
    created: boolean;
  }> {
    const existing = this.records.get(input.id);
    if (existing) {
      if (
        existing.taskId !== input.taskId ||
        existing.topic !== input.topic ||
        !isDeepStrictEqual(existing.payload, input.payload)
      ) {
        throw new TaskOutboxConflictError(input.id);
      }
      return { record: cloneRecord(existing), created: false };
    }

    const record: TaskOutboxRecord<TPayload> = {
      id: input.id,
      taskId: input.taskId,
      topic: input.topic,
      payload: input.payload,
      status: 'PENDING',
      attempt: 0,
      availableAt: new Date(input.availableAt ?? input.now),
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    };
    this.records.set(record.id, record);
    return { record: cloneRecord(record), created: true };
  }

  async claimBatch(input: ClaimTaskOutboxInput): Promise<TaskOutboxRecord<TPayload>[]> {
    if (input.limit < 1) return [];
    if (input.leaseExpiresAt.getTime() <= input.now.getTime()) return [];

    const claimable = [...this.records.values()]
      .filter((record) => {
        if (record.availableAt.getTime() > input.now.getTime()) return false;
        if (record.status === 'PENDING') return true;
        return (
          record.status === 'PUBLISHING' &&
          Boolean(record.leaseExpiresAt && record.leaseExpiresAt.getTime() <= input.now.getTime())
        );
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, input.limit);

    return claimable.map((record) => {
      record.status = 'PUBLISHING';
      record.workerId = input.workerId;
      record.leaseToken = input.leaseToken;
      record.leaseExpiresAt = new Date(input.leaseExpiresAt);
      record.attempt += 1;
      record.updatedAt = new Date(input.now);
      return cloneRecord(record);
    });
  }

  async markPublished(id: string, leaseToken: string, now: Date): Promise<boolean> {
    const record = this.records.get(id);
    if (
      !record ||
      record.status !== 'PUBLISHING' ||
      record.leaseToken !== leaseToken ||
      !record.leaseExpiresAt ||
      record.leaseExpiresAt.getTime() <= now.getTime()
    )
      return false;

    record.status = 'PUBLISHED';
    record.workerId = undefined;
    record.leaseToken = undefined;
    record.leaseExpiresAt = undefined;
    record.publishedAt = new Date(now);
    record.updatedAt = new Date(now);
    record.lastError = undefined;
    return true;
  }

  async reschedule(
    id: string,
    leaseToken: string,
    availableAt: Date,
    errorSummary: string,
    now: Date,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (
      !record ||
      record.status !== 'PUBLISHING' ||
      record.leaseToken !== leaseToken ||
      !record.leaseExpiresAt ||
      record.leaseExpiresAt.getTime() <= now.getTime()
    )
      return false;

    record.status = 'PENDING';
    record.workerId = undefined;
    record.leaseToken = undefined;
    record.leaseExpiresAt = undefined;
    record.availableAt = new Date(availableAt);
    record.updatedAt = new Date(now);
    record.lastError = errorSummary;
    return true;
  }
}
