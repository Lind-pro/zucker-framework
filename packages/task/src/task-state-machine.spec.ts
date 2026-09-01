import {
  InvalidTaskTransitionError,
  assertTaskTransition,
  canTransitionTask,
  isTerminalTaskStatus,
  requiresTaskLease,
  type TaskStatus,
} from './task-state-machine';

describe('task state machine', () => {
  it.each<[TaskStatus, TaskStatus]>([
    ['QUEUED', 'PROCESSING'],
    ['PROCESSING', 'WAITING_PROVIDER'],
    ['WAITING_PROVIDER', 'PROCESSING'],
    ['PROCESSING', 'RETRYING'],
    ['RETRYING', 'QUEUED'],
    ['PROCESSING', 'COMPLETED'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
    expect(() => assertTaskTransition(from, to)).not.toThrow();
  });

  it.each<[TaskStatus, TaskStatus]>([
    ['QUEUED', 'COMPLETED'],
    ['WAITING_PROVIDER', 'COMPLETED'],
    ['COMPLETED', 'PROCESSING'],
    ['FAILED', 'QUEUED'],
    ['CANCELLED', 'PROCESSING'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(false);
    expect(() => assertTaskTransition(from, to)).toThrow(InvalidTaskTransitionError);
  });

  it('classifies terminal and lease-protected states', () => {
    expect(isTerminalTaskStatus('COMPLETED')).toBe(true);
    expect(isTerminalTaskStatus('PROCESSING')).toBe(false);
    expect(requiresTaskLease('PROCESSING')).toBe(true);
    expect(requiresTaskLease('WAITING_PROVIDER')).toBe(true);
    expect(requiresTaskLease('RETRYING')).toBe(false);
    expect(requiresTaskLease('QUEUED')).toBe(false);
  });
});
