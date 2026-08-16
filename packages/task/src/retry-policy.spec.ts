import { ExponentialTaskRetryPolicy } from './retry-policy';
import type { TaskErrorSummary } from './task-repository';

const error = (overrides: Partial<TaskErrorSummary> = {}): TaskErrorSummary => ({
  code: 'PROVIDER_TIMEOUT',
  category: 'PROVIDER_TIMEOUT',
  summary: 'provider did not respond',
  retryable: true,
  ...overrides,
});

describe('ExponentialTaskRetryPolicy', () => {
  it('uses exponential backoff without jitter when jitter is disabled', () => {
    const policy = new ExponentialTaskRetryPolicy({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0,
    });

    expect(policy.decide({ error: error(), attempt: 1, maxAttempts: 4 })).toEqual({
      retry: true,
      delayMs: 1_000,
    });
    expect(policy.decide({ error: error(), attempt: 3, maxAttempts: 4 })).toEqual({
      retry: true,
      delayMs: 4_000,
    });
  });

  it('honors provider retry-after without exceeding the configured cap', () => {
    const policy = new ExponentialTaskRetryPolicy({
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    });

    expect(
      policy.decide({
        error: error({ category: 'RATE_LIMIT' }),
        attempt: 1,
        maxAttempts: 3,
        retryAfterMs: 8_000,
      }),
    ).toEqual({ retry: true, delayMs: 8_000 });
    expect(
      policy.decide({
        error: error({ category: 'RATE_LIMIT' }),
        attempt: 1,
        maxAttempts: 3,
        retryAfterMs: 60_000,
      }),
    ).toEqual({ retry: true, delayMs: 10_000 });
  });

  it('does not retry validation errors even if a caller marks them retryable', () => {
    const policy = new ExponentialTaskRetryPolicy();
    expect(
      policy.decide({
        error: error({ category: 'VALIDATION' }),
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({ retry: false, reason: 'NON_RETRYABLE' });
  });

  it('stops after the attempt budget is exhausted', () => {
    const policy = new ExponentialTaskRetryPolicy();
    expect(policy.decide({ error: error(), attempt: 3, maxAttempts: 3 })).toEqual({
      retry: false,
      reason: 'ATTEMPTS_EXHAUSTED',
    });
  });

  it('applies bounded jitter using an injected random source', () => {
    const low = new ExponentialTaskRetryPolicy({ jitterRatio: 0.2, random: () => 0 });
    const high = new ExponentialTaskRetryPolicy({ jitterRatio: 0.2, random: () => 1 });

    expect(low.decide({ error: error(), attempt: 1, maxAttempts: 3 })).toEqual({
      retry: true,
      delayMs: 800,
    });
    expect(high.decide({ error: error(), attempt: 1, maxAttempts: 3 })).toEqual({
      retry: true,
      delayMs: 1_200,
    });
  });
});
