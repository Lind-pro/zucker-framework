export type TaskOutboxStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED';

export interface TaskOutboxRecord<TPayload = unknown> {
  id: string;
  taskId: string;
  topic: string;
  payload: TPayload;
  status: TaskOutboxStatus;
  attempt: number;
  availableAt: Date;
  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

export interface AppendTaskOutboxInput<TPayload> {
  id: string;
  taskId: string;
  topic: string;
  payload: TPayload;
  availableAt?: Date;
  now: Date;
}

export interface ClaimTaskOutboxInput {
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  limit: number;
  now: Date;
}

export interface TaskOutboxRepository<TPayload = unknown> {
  append(
    input: AppendTaskOutboxInput<TPayload>,
  ): Promise<{ record: TaskOutboxRecord<TPayload>; created: boolean }>;
  claimBatch(input: ClaimTaskOutboxInput): Promise<TaskOutboxRecord<TPayload>[]>;
  markPublished(id: string, leaseToken: string, now: Date): Promise<boolean>;
  reschedule(
    id: string,
    leaseToken: string,
    availableAt: Date,
    errorSummary: string,
    now: Date,
  ): Promise<boolean>;
}

export interface TaskQueuePublisher<TPayload = unknown> {
  publish(message: TaskOutboxRecord<TPayload>): Promise<void>;
}

export class TaskOutboxConflictError extends Error {
  constructor(readonly eventId: string) {
    super(`Outbox event id was reused with different content: ${eventId}`);
    this.name = 'TaskOutboxConflictError';
  }
}
