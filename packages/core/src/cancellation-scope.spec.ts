import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCancellationScope, waitForSignal } from './cancellation-scope';
afterEach(() => vi.useRealTimers());
describe('cancellation scope', () => {
  it('detaches the parent when disposed and preserves an already-aborted reason', () => {
    const parent = new AbortController();
    const scope = createCancellationScope({ parent: parent.signal });
    scope.dispose();
    const reason = new Error('stop');
    parent.abort(reason);
    expect(scope.signal.aborted).toBe(false);
    expect(createCancellationScope({ parent: parent.signal }).signal.reason).toBe(reason);
  });
  it('keeps the configured timeout error and consumes late rejection', async () => {
    vi.useFakeTimers();
    const timeout = new Error('deadline');
    const scope = createCancellationScope({ timeoutMs: 20, timeoutReason: () => timeout });
    let fail!: (error: Error) => void;
    const operation = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });
    const result = expect(waitForSignal(operation, scope.signal)).rejects.toBe(timeout);
    await vi.advanceTimersByTimeAsync(20);
    await result;
    fail(new Error('late'));
    await Promise.resolve();
    scope.dispose();
  });
});
