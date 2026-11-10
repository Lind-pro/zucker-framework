import { describe, expect, it, vi } from 'vitest';

import { InMemoryTaskRepository } from './in-memory-task-repository';
import { ExponentialTaskRetryPolicy } from './retry-policy';
import type { CreateTaskInput, TaskErrorSummary } from './task-repository';
import {
  DurableTaskLeaseLostError,
  DurableTaskAbortedError,
  DurableTaskNotClaimableError,
  DurableTaskNotFoundError,
  DurableTaskRetryScheduledError,
  DurableWorkerRuntime,
  UnsupportedDurableTaskKindError,
  type DurableTaskAttemptContext,
  type DurableTaskHandler,
  type DurableWorkerHeartbeatScheduler,
} from './durable-worker-runtime';

type Payload = { documentId: string };
type Result = { artifactId: string };

const at = (seconds: number) =>
  new Date(`2026-08-15T00:00:${String(seconds).padStart(2, '0')}.000Z`);

const input = (overrides: Partial<CreateTaskInput<Payload>> = {}): CreateTaskInput<Payload> => ({
  id: 'task-1',
  kind: 'DOCUMENT_RENDER',
  resource: { type: 'document', id: 'document-1' },
  idempotencyKey: 'document-1:render:v1',
  idempotencyFingerprint: 'sha256:request',
  handlerVersion: 'v1',
  payload: { documentId: 'document-1' },
  maxAttempts: 3,
  now: at(0),
  ...overrides,
});

const classifiedError: TaskErrorSummary = {
  code: 'PROVIDER_TIMEOUT',
  category: 'PROVIDER_TIMEOUT',
  summary: 'provider timed out',
  retryable: true,
};

class ManualHeartbeatScheduler implements DurableWorkerHeartbeatScheduler {
  tick: (() => Promise<void>) | null = null;
  stopped = false;

  start(tick: () => Promise<void>): unknown {
    this.tick = tick;
    return 'heartbeat';
  }

  stop(): void {
    this.stopped = true;
  }

  async runTick(): Promise<void> {
    if (!this.tick) throw new Error('Heartbeat was not started');
    await this.tick();
  }
}

function createRuntime(options: {
  repository: InMemoryTaskRepository<Payload, Result>;
  handler?: DurableTaskHandler<Payload, Result> | null;
  scheduler?: ManualHeartbeatScheduler;
  now?: () => Date;
  onAbort?: (taskId: string) => void;
}) {
  return new DurableWorkerRuntime<Payload, Result>({
    repository: options.repository,
    resolveHandler: () => options.handler,
    retryPolicy: new ExponentialTaskRetryPolicy({
      baseDelayMs: 5_000,
      maxDelayMs: 5_000,
      jitterRatio: 0,
    }),
    classifyError: () => classifiedError,
    workerId: 'worker-1',
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    now: options.now ?? (() => at(1)),
    createLeaseToken: () => 'lease-1',
    heartbeatScheduler: options.scheduler,
    onAbort: options.onAbort ? (task) => options.onAbort?.(task.id) : undefined,
  });
}

describe('DurableWorkerRuntime', () => {
  it('does not claim a task when the host signal is already aborted', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    const execute = vi.fn(async () => ({ artifactId: 'never' }));
    const stopped = new AbortController(); stopped.abort();
    await expect(createRuntime({ repository, handler: { execute } }).run('task-1', { signal: stopped.signal }))
      .rejects.toBeInstanceOf(DurableTaskAbortedError);
    expect(execute).not.toHaveBeenCalled();
    expect(await repository.findById('task-1')).toMatchObject({ status: 'QUEUED', attempt: 0 });
  });

  it('stops host-interrupted heartbeats, drains renewal and leaves the attempt for durable lease recovery', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    const scheduler = new ManualHeartbeatScheduler(), stopped = new AbortController();
    let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    let finishRenewal!: () => void; const renewal = new Promise<void>(done => { finishRenewal = done; });
    const heartbeat = vi.spyOn(repository, 'heartbeat').mockImplementationOnce(async () => { await renewal; return true; });
    const cleanup = vi.fn();
    const runtime = createRuntime({ repository, scheduler, handler: {
      execute: async context => {
        entered();
        await new Promise<void>((_done, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
        return { artifactId: 'never' };
      }, cleanup,
    } });
    let settled = false;
    const running = runtime.run('task-1', { signal: stopped.signal }).finally(() => { settled = true; });
    const rejection = expect(running).rejects.toBeInstanceOf(DurableTaskAbortedError);
    await started;
    const tick = scheduler.runTick();
    stopped.abort();
    await Promise.resolve(); await Promise.resolve();
    expect(scheduler.stopped).toBe(true);
    expect(settled).toBe(false);
    finishRenewal(); await tick; await rejection;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledOnce();
    const retained = await repository.findById('task-1');
    expect(retained).toMatchObject({ status: 'PROCESSING', attempt: 1 });
    expect(retained?.result).toBeUndefined();
  });

  it('returns a typed error when the durable task does not exist', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();

    await expect(
      createRuntime({
        repository,
        handler: { execute: async () => ({ artifactId: 'never' }) },
      }).run('missing-task'),
    ).rejects.toBeInstanceOf(DurableTaskNotFoundError);
  });

  it('claims, reports progress, and completes a task with lease fencing', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    const execute = vi.fn(async (context: DurableTaskAttemptContext<Payload, Result>) => {
      await context.reportProgress('rendering', 60);
      await context.assertActive();
      return { artifactId: 'artifact-1' };
    });

    await expect(
      createRuntime({ repository, handler: { execute } }).run('task-1'),
    ).resolves.toEqual({
      taskId: 'task-1',
      kind: 'DOCUMENT_RENDER',
      status: 'COMPLETED',
    });
    expect(execute).toHaveBeenCalledOnce();
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'COMPLETED',
      progress: 100,
      result: { artifactId: 'artifact-1' },
      attempt: 1,
    });
  });

  it('returns terminal tasks without resolving or running a handler', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    await repository.claim({
      id: 'task-1',
      workerId: 'old-worker',
      leaseToken: 'old-lease',
      leaseExpiresAt: at(20),
      now: at(1),
    });
    await repository.transition({
      id: 'task-1',
      from: 'PROCESSING',
      to: 'COMPLETED',
      leaseToken: 'old-lease',
      result: { artifactId: 'existing' },
      now: at(2),
    });

    await expect(createRuntime({ repository, handler: null }).run('task-1')).resolves.toMatchObject(
      {
        status: 'COMPLETED',
      },
    );
  });

  it('rejects a queued task without a registered handler', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());

    await expect(createRuntime({ repository, handler: null }).run('task-1')).rejects.toBeInstanceOf(
      UnsupportedDurableTaskKindError,
    );
  });

  it('rejects duplicate delivery while another worker owns the task', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    await repository.claim({
      id: 'task-1',
      workerId: 'old-worker',
      leaseToken: 'old-lease',
      leaseExpiresAt: at(20),
      now: at(1),
    });

    await expect(
      createRuntime({
        repository,
        handler: { execute: async () => ({ artifactId: 'never' }) },
      }).run('task-1'),
    ).rejects.toBeInstanceOf(DurableTaskNotClaimableError);
  });

  it('aborts the handler when a heartbeat reports a lost lease', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    const scheduler = new ManualHeartbeatScheduler();
    const onAbort = vi.fn();
    await repository.create(input());
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let contextSignal: AbortSignal | undefined;
    const handler: DurableTaskHandler<Payload, Result> = {
      execute: async (context) => {
        contextSignal = context.signal;
        await waiting;
        throw context.signal.reason;
      },
    };
    const run = createRuntime({ repository, handler, scheduler, onAbort }).run('task-1');
    await vi.waitFor(() => expect(contextSignal).toBeDefined());
    await repository.cancel('task-1', at(2));
    await scheduler.runTick();
    release?.();

    await expect(run).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(contextSignal?.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(scheduler.stopped).toBe(true);
  });

  it('aborts after consecutive heartbeat storage errors', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    const scheduler = new ManualHeartbeatScheduler();
    const onAbort = vi.fn();
    await repository.create(input());
    const heartbeat = vi
      .spyOn(repository, 'heartbeat')
      .mockRejectedValue(new Error('storage unavailable'));
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let contextSignal: AbortSignal | undefined;
    const run = createRuntime({
      repository,
      scheduler,
      onAbort,
      handler: {
        execute: async (context) => {
          contextSignal = context.signal;
          await waiting;
          throw context.signal.reason;
        },
      },
    }).run('task-1');
    await vi.waitFor(() => expect(contextSignal).toBeDefined());

    await scheduler.runTick();
    await scheduler.runTick();
    expect(contextSignal?.aborted).toBe(false);
    await scheduler.runTick();
    release?.();

    await expect(run).rejects.toBeInstanceOf(DurableTaskLeaseLostError);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it('uses default retry transitions and throws a typed transport signal', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    let current = at(1);
    const run = createRuntime({
      repository,
      now: () => current,
      handler: {
        execute: async () => {
          throw new Error('provider timeout');
        },
      },
    }).run('task-1');

    const retryError = await run.catch((error: unknown) => error);
    expect(retryError).toBeInstanceOf(DurableTaskRetryScheduledError);
    expect(retryError).toMatchObject({
      taskId: 'task-1',
      taskError: classifiedError,
      retryAt: at(6),
    });
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'QUEUED',
      attempt: 1,
      availableAt: at(6),
      error: classifiedError,
    });
    current = at(6);
  });

  it('delegates retry and failure commits to domain handlers', async () => {
    const retryRepository = new InMemoryTaskRepository<Payload, Result>();
    await retryRepository.create(input());
    const retry = vi.fn(async () => true);
    await expect(
      createRuntime({
        repository: retryRepository,
        handler: {
          execute: async () => {
            throw new Error('retry');
          },
          retry,
        },
      }).run('task-1'),
    ).rejects.toBeInstanceOf(DurableTaskRetryScheduledError);
    expect(retry).toHaveBeenCalledOnce();

    const failRepository = new InMemoryTaskRepository<Payload, Result>();
    await failRepository.create(input({ maxAttempts: 1 }));
    const fail = vi.fn(async () => true);
    await expect(
      createRuntime({
        repository: failRepository,
        handler: {
          execute: async () => {
            throw new Error('fail');
          },
          fail,
        },
      }).run('task-1'),
    ).resolves.toMatchObject({ status: 'FAILED' });
    expect(fail).toHaveBeenCalledOnce();
  });

  it('uses the default terminal failure transition when attempts are exhausted', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input({ maxAttempts: 1 }));

    await expect(
      createRuntime({
        repository,
        handler: {
          execute: async () => {
            throw new Error('invalid input');
          },
        },
      }).run('task-1'),
    ).resolves.toMatchObject({ status: 'FAILED' });
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'FAILED',
      error: classifiedError,
      attempt: 1,
    });
  });

  it('does not overwrite cancellation that wins during execution', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    const handler: DurableTaskHandler<Payload, Result> = {
      execute: async (context) => {
        await repository.cancel(context.task.id, at(2));
        throw new Error('provider noticed cancellation');
      },
      onCancelled: vi.fn(),
    };

    await expect(createRuntime({ repository, handler }).run('task-1')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    expect(handler.onCancelled).toHaveBeenCalledOnce();
    await expect(repository.findById('task-1')).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('rejects a late custom completion and still runs cleanup', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    const cleanup = vi.fn();
    const handler: DurableTaskHandler<Payload, Result> = {
      execute: async () => ({ artifactId: 'late' }),
      complete: async () => false,
      cleanup,
    };

    await expect(createRuntime({ repository, handler }).run('task-1')).rejects.toBeInstanceOf(
      DurableTaskLeaseLostError,
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('normalizes retrying tasks without bypassing their availability time', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    await repository.claim({
      id: 'task-1',
      workerId: 'old-worker',
      leaseToken: 'old-lease',
      leaseExpiresAt: at(20),
      now: at(1),
    });
    await repository.transition({
      id: 'task-1',
      from: 'PROCESSING',
      to: 'RETRYING',
      leaseToken: 'old-lease',
      error: classifiedError,
      availableAt: at(10),
      now: at(2),
    });

    await expect(
      createRuntime({
        repository,
        now: () => at(5),
        handler: { execute: async () => ({ artifactId: 'never' }) },
      }).run('task-1'),
    ).rejects.toBeInstanceOf(DurableTaskNotClaimableError);
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'QUEUED',
      availableAt: at(10),
    });
  });

  it('keeps the last error when a RETRYING task is normalized to QUEUED', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    await repository.claim({
      id: 'task-1',
      workerId: 'old-worker',
      leaseToken: 'old-lease',
      leaseExpiresAt: at(20),
      now: at(1),
    });
    await repository.transition({
      id: 'task-1',
      from: 'PROCESSING',
      to: 'RETRYING',
      leaseToken: 'old-lease',
      error: classifiedError,
      availableAt: at(10),
      now: at(2),
    });
    await createRuntime({
      repository,
      now: () => at(5),
      handler: { execute: async () => ({ artifactId: 'never' }) },
    })
      .run('task-1')
      .catch(() => undefined);
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'QUEUED',
      error: classifiedError,
    });
  });

  it('treats a requeue that lost the race to the reconciler as a scheduled retry', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    const transition = repository.transition.bind(repository);
    vi.spyOn(repository, 'transition').mockImplementation(async (request) => {
      if (request.from === 'RETRYING') {
        // Simulate the reconciler requeuing first.
        await transition({ ...request });
        return null;
      }
      return transition(request);
    });
    const run = createRuntime({
      repository,
      handler: {
        execute: async () => {
          throw new Error('provider timeout');
        },
      },
    }).run('task-1');
    await expect(run).rejects.toBeInstanceOf(DurableTaskRetryScheduledError);
    await expect(repository.findById('task-1')).resolves.toMatchObject({ status: 'QUEUED' });
  });

  it('keeps unsupported kinds queued by default and reports them', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    const onUnsupportedKind = vi.fn();
    const runtime = new DurableWorkerRuntime<Payload, Result>({
      repository,
      resolveHandler: () => null,
      retryPolicy: new ExponentialTaskRetryPolicy({ baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
      classifyError: () => classifiedError,
      workerId: 'worker-1',
      now: () => at(59),
      onUnsupportedKind,
    });
    await expect(runtime.run('task-1')).rejects.toBeInstanceOf(UnsupportedDurableTaskKindError);
    expect(onUnsupportedKind).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }));
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'QUEUED',
      attempt: 0,
    });
  });

  it('fails an unsupported kind once failUnsupportedKindAfterMs has elapsed', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(input());
    let now = at(10);
    const runtime = new DurableWorkerRuntime<Payload, Result>({
      repository,
      resolveHandler: () => null,
      retryPolicy: new ExponentialTaskRetryPolicy({ baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
      classifyError: () => classifiedError,
      workerId: 'worker-1',
      now: () => now,
      failUnsupportedKindAfterMs: 30_000,
    });
    await expect(runtime.run('task-1')).rejects.toBeInstanceOf(UnsupportedDurableTaskKindError);
    now = at(31);
    await expect(runtime.run('task-1')).resolves.toMatchObject({ status: 'FAILED' });
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'FAILED',
      error: expect.objectContaining({ code: 'UNSUPPORTED_TASK_KIND', retryable: false }),
    });
  });
});
