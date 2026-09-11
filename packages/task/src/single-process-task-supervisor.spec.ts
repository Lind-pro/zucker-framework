import { expect, it, vi } from 'vitest';
import { SingleProcessTaskSupervisor } from './single-process-task-supervisor';
it('resumes recovered keys, deduplicates work and bounds running callbacks', async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  const supervisor = new SingleProcessTaskSupervisor({
    concurrency: 1,
    scanIntervalMs: 60_000,
    initialize: async () => ['a'],
    loadPending: async () => ['a', 'a'],
    run,
    abort: vi.fn(),
  });
  await supervisor.onApplicationBootstrap();
  await supervisor.waitForIdle();
  expect(run).toHaveBeenCalledExactlyOnceWith('a', true);
  await supervisor.onApplicationShutdown();
});
it('drops queued work and aborts active work on shutdown without waiting for it', async () => {
  const run = vi.fn(() => new Promise<void>(() => {}));
  const abort = vi.fn();
  const supervisor = new SingleProcessTaskSupervisor({
    concurrency: 1,
    scanIntervalMs: 1000,
    loadPending: async () => [],
    run,
    abort,
  });
  supervisor.submit('a');
  supervisor.submit('b');
  await Promise.resolve();
  await supervisor.onApplicationShutdown();
  expect(run).toHaveBeenCalledExactlyOnceWith('a', false);
  expect(abort).toHaveBeenCalledExactlyOnceWith('a');
});
