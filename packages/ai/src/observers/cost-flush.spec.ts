import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PersistedCostTracker } from './cost-persister';
const entry = (modelRecordId: string | undefined = 'record') => ({ timestamp: 0, provider: 'openai', model: 'same', modelRecordId, inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 0 });
describe('cost snapshot flush', () => {
  it('serializes overlapping flush and preserves records arriving during persistence', async () => {
    let release!: () => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { release = r; })).mockResolvedValue(undefined);
    const tracker = new PersistedCostTracker({ persist });
    tracker.record(entry());
    const first = tracker.flush();
    const concurrent = tracker.flush();
    tracker.record(entry());
    release();
    await Promise.all([first, concurrent]);
    await tracker.flush();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls.map(([rows]) => rows[0].requestCount)).toEqual([1, 1]);
  });
  it('restores failed snapshots, surfaces errors and warns for missing IDs even in mixed batches', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const persist = vi.fn().mockRejectedValueOnce(new Error('synthetic storage failure')).mockResolvedValue(undefined);
    const tracker = new PersistedCostTracker({ persist });
    tracker.record(entry());
    tracker.record({ ...entry(), modelRecordId: undefined });
    await expect(tracker.flush()).rejects.toThrow('storage failure');
    tracker.record(entry());
    await tracker.flush();
    expect(persist.mock.calls[1][0][0].requestCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('modelRecordId'));
    warn.mockRestore();
  });
});
