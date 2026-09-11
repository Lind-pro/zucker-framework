import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConcurrencyBulkhead } from './concurrency-bulkhead';
afterEach(() => vi.useRealTimers());
describe('bounded concurrency', () => {
  it('rejects overflow and timed-out waiters while releasing capacity on failure', async () => {
    vi.useFakeTimers();
    const unavailable = new Error('busy');
    const gate = new ConcurrencyBulkhead(1, 1, 30, () => unavailable);
    let release!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const queued = expect(gate.run(async () => 2)).rejects.toBe(unavailable);
    await expect(gate.run(async () => 3)).rejects.toBe(unavailable);
    await vi.advanceTimersByTimeAsync(30);
    await queued;
    release();
    await first;
    await expect(
      gate.run(async () => {
        throw new Error('job');
      }),
    ).rejects.toThrow('job');
    await expect(gate.run(async () => 4)).resolves.toBe(4);
  });
});
