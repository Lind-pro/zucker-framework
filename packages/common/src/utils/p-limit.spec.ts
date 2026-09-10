import { describe, expect, it, vi } from 'vitest';
import { pLimit } from './p-limit';

describe('pLimit consumer failure contracts', () => {
  it('keeps the existing error-as-result behavior by default', async () => {
    const error = new Error('item failed');
    const result = await pLimit([1, 2, 3], 2, async (value) => {
      if (value === 2) throw error;
      return value * 2;
    });
    expect(result).toEqual([2, error, 6]);
  });

  it('rejects with the original failure and stops dispatching queued work when requested', async () => {
    const error = new Error('provider unavailable');
    let finishInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      finishInFlight = resolve;
    });
    const run = vi.fn(async (value: number) => {
      if (value === 1) await inFlight;
      if (value === 2) throw error;
      return value;
    });

    await expect(pLimit([1, 2, 3, 4], 2, run, { rejectOnError: true })).rejects.toBe(error);
    expect(run.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    finishInFlight();
    await inFlight;
    await Promise.resolve();
    expect(run.mock.calls.map(([value]) => value)).toEqual([1, 2]);
  });

  it('preserves result ordering and the concurrency bound in rejection mode', async () => {
    let active = 0;
    let maximum = 0;
    const results = await pLimit(
      [3, 1, 2],
      2,
      async (value) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return value * 10;
      },
      { rejectOnError: true },
    );
    expect(results).toEqual([30, 10, 20]);
    expect(maximum).toBe(2);
  });
});
