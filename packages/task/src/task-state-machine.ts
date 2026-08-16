export const TASK_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'WAITING_PROVIDER',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  QUEUED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['WAITING_PROVIDER', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING_PROVIDER: ['PROCESSING', 'RETRYING', 'FAILED', 'CANCELLED'],
  RETRYING: ['QUEUED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export class InvalidTaskTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new InvalidTaskTransitionError(from, to);
  }
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

export function requiresTaskLease(status: TaskStatus): boolean {
  return status === 'PROCESSING' || status === 'WAITING_PROVIDER';
}
