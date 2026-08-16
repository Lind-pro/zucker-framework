import { AICallAbortedError, AICallTimeoutError } from './ai-call-errors';
import { AICallWrapper } from './call-wrapper';

describe('AICallWrapper cancellation contract', () => {
  it('has no implicit framework timeout', async () => {
    const wrapper = new AICallWrapper();
    const result = await wrapper.callWithRetry(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'late-success';
      },
      { maxAttempts: 1 },
    );

    expect(result).toBe('late-success');
  });

  it('aborts an explicit deadline and does not retry it by default', async () => {
    const wrapper = new AICallWrapper();
    const signals: AbortSignal[] = [];
    let attempts = 0;

    await expect(
      wrapper.callWithRetry(
        async ({ signal }) => {
          attempts += 1;
          signals.push(signal);
          return new Promise<string>(() => undefined);
        },
        {
          timeoutMs: 10,
          maxAttempts: 3,
          baseDelayMs: 1,
        },
      ),
    ).rejects.toBeInstanceOf(AICallTimeoutError);

    expect(attempts).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('only retries timeouts after explicit opt-in', async () => {
    const wrapper = new AICallWrapper();
    let attempts = 0;

    await expect(
      wrapper.callWithRetry(
        async () => {
          attempts += 1;
          return new Promise<string>(() => undefined);
        },
        {
          timeoutMs: 5,
          maxAttempts: 2,
          retryTimeouts: true,
          baseDelayMs: 1,
        },
      ),
    ).rejects.toBeInstanceOf(AICallTimeoutError);
    expect(attempts).toBe(2);
  });

  it('propagates caller cancellation to the active attempt', async () => {
    const wrapper = new AICallWrapper();
    const controller = new AbortController();
    let attemptSignal: AbortSignal | undefined;
    const call = wrapper.callWithRetry(
      async ({ signal }) => {
        attemptSignal = signal;
        return new Promise<string>(() => undefined);
      },
      { signal: controller.signal, maxAttempts: 3 },
    );

    controller.abort();
    await expect(call).rejects.toBeInstanceOf(AICallAbortedError);
    expect(attemptSignal?.aborted).toBe(true);
  });

  it('cancels a stalled stream iterator and calls return for cleanup', async () => {
    const wrapper = new AICallWrapper();
    const returnIterator = vi.fn().mockResolvedValue({ done: true, value: undefined });
    const iterator: AsyncIterator<string> = {
      next: () => new Promise(() => undefined),
      return: returnIterator,
    };

    await expect(
      wrapper.callWithStream(
        async () => ({ [Symbol.asyncIterator]: () => iterator }),
        (content) => ({ content }),
        { timeoutMs: 10 },
      ),
    ).rejects.toBeInstanceOf(AICallTimeoutError);
    expect(returnIterator).toHaveBeenCalledTimes(1);
  });
});
