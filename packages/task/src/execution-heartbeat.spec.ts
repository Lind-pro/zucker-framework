import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionHeartbeatError, runWithExecutionHeartbeat } from './execution-heartbeat';

afterEach(() => vi.useRealTimers());

describe('runWithExecutionHeartbeat', () => {
  it('resets consecutive failures on success and aborts with the heartbeat failure', async () => {
    vi.useFakeTimers();
    const failure = new Error('database unavailable');
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(failure);
    const parent = new AbortController();
    const run = runWithExecutionHeartbeat(
      {
        signal: parent.signal,
        intervalMs: 10,
        failureThreshold: 2,
        heartbeat,
      },
      (signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const failed = expect(run).rejects.toMatchObject({
      name: 'ExecutionHeartbeatError',
      consecutiveFailures: 2,
      cause: failure,
    });
    await vi.advanceTimersByTimeAsync(40);
    await failed;
    expect(heartbeat).toHaveBeenCalledTimes(4);
    expect(parent.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never overlaps heartbeats and settles in-flight cleanup before returning', async () => {
    vi.useFakeTimers();
    let finishHeartbeat!: () => void;
    let finishWork!: () => void;
    const heartbeat = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishHeartbeat = resolve;
        }),
    );
    const done = vi.fn();
    const run = runWithExecutionHeartbeat(
      { intervalMs: 10, failureThreshold: 2, heartbeat },
      () =>
        new Promise<void>((resolve) => {
          finishWork = resolve;
        }),
    ).then(done);
    await vi.advanceTimersByTimeAsync(100);
    expect(heartbeat).toHaveBeenCalledOnce();
    finishWork();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    finishHeartbeat();
    await run;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it('preserves caller cancellation and does not label it heartbeat failure', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const reason = new Error('caller cancelled');
    const run = runWithExecutionHeartbeat(
      {
        signal: parent.signal,
        intervalMs: 10,
        failureThreshold: 2,
        heartbeat: vi.fn(),
      },
      (signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const failed = expect(run).rejects.toBe(reason);
    parent.abort(reason);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects even when work swallows a heartbeat abort and returns a result', async () => {
    vi.useFakeTimers();
    const run = runWithExecutionHeartbeat(
      {
        intervalMs: 10,
        failureThreshold: 1,
        heartbeat: async () => {
          throw new Error('offline');
        },
      },
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('late success'), { once: true });
        }),
    );
    const failed = expect(run).rejects.toBeInstanceOf(ExecutionHeartbeatError);
    await vi.advanceTimersByTimeAsync(10);
    await failed;
  });
});
