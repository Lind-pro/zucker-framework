import { describe, expect, it, vi } from 'vitest';
import { AIAccessClientSession } from './client-session';
import type { AIAccessResult } from './contracts';
const result = {
  content: 'synthetic',
  finishReason: 'stop',
  tokenUsage: { input: 1, output: 1, total: 2 },
} satisfies AIAccessResult;
const request = { model: 'configured', input: 'synthetic' };

describe('AIAccessClientSession', () => {
  it('shares client initialization but executes each explicit request once', async () => {
    const complete = vi.fn(async () => result);
    const create = vi.fn(async () => ({ complete }));
    const session = new AIAccessClientSession(create);
    await Promise.all([session.complete(request), session.complete(request)]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('allows initialization recovery but never retries a failed provider call', async () => {
    const failure = new Error('provider failed');
    const complete = vi.fn(async () => {
      throw failure;
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValue({ complete });
    const session = new AIAccessClientSession(create);
    await expect(session.complete(request)).rejects.toThrow('load failed');
    const onFailure = vi.fn();
    await expect(session.complete(request, { onFailure })).rejects.toBe(failure);
    expect(create).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(failure, expect.any(Number));
  });
});
