import { TaskLifecycleManager, type TaskContext } from './task-lifecycle';

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('TaskLifecycleManager', () => {
  it('aborts the attempt signal on timeout and does not overlap retries', async () => {
    const manager = new TaskLifecycleManager();
    let running = 0;
    let maxRunning = 0;
    const signals: AbortSignal[] = [];
    const id = manager.submit({
      name: 'cooperative',
      timeoutMs: 20,
      maxRetries: 1,
      handler: (ctx: TaskContext) => {
        signals.push(ctx.signal);
        running++;
        maxRunning = Math.max(maxRunning, running);
        return new Promise((_, reject) => {
          ctx.signal.addEventListener('abort', () => {
            setTimeout(() => { running--; reject(new Error('aborted')); }, 5);
          });
        });
      },
    });
    await waitFor(() => manager.getTask(id)?.status === 'failed', 5_000);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(maxRunning).toBe(1);
  });

  it('does not retry an attempt whose handler ignores the abort', async () => {
    const manager = new TaskLifecycleManager();
    let calls = 0;
    const id = manager.submit({
      name: 'stuck',
      timeoutMs: 10,
      maxRetries: 3,
      handler: () => { calls++; return new Promise(() => {}); },
    });
    await waitFor(() => manager.getTask(id)?.status === 'failed');
    expect(calls).toBe(1);
    expect(manager.getTask(id)?.error).toMatch(/not retried/);
  });

  it('aborts the running handler on kill and prunes cancelled ids on cleanup', async () => {
    const manager = new TaskLifecycleManager();
    let signal: AbortSignal | undefined;
    const id = manager.submit({
      name: 'killable',
      handler: (ctx) => { signal = ctx.signal; return new Promise(() => {}); },
    });
    await waitFor(() => signal !== undefined);
    expect(manager.kill(id)).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(manager.cleanup(-1)).toBe(1);
    // @ts-expect-error private access for test
    expect(manager.cancelledTasks.size).toBe(0);
  });

  it('clears the timeout timer when the handler finishes first', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const manager = new TaskLifecycleManager();
    const id = manager.submit({ name: 'fast', timeoutMs: 60_000, handler: async () => 42 });
    await waitFor(() => manager.getTask(id)?.status === 'completed');
    expect(manager.getTask(id)?.result).toBe(42);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
