// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorTracker, errorFingerprint } from './error-tracker';

describe('bounded error aggregation', () => {
  afterEach(() => vi.useRealTimers());
  it('expires a fixed fingerprint window and invokes first-occurrence policy once per window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const onNewError = vi.fn();
    const tracker = new ErrorTracker({
      retentionMs: 60_000,
      logEntries: false,
      onNewError,
      fingerprint: (error, _category, metadata) =>
        errorFingerprint(error, String(metadata?.endpoint ?? '')),
    });
    const error = new Error('Failure');
    tracker.track(error, 'service', { endpoint: '/one' });
    vi.advanceTimersByTime(30_000);
    tracker.track(error, 'service', { endpoint: '/one' });
    expect(tracker.getErrors()[0].count).toBe(2);
    expect(onNewError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    expect(tracker.getErrors()).toEqual([]);
    tracker.track(error, 'service', { endpoint: '/one' });
    expect(onNewError).toHaveBeenCalledTimes(2);
    tracker.track(error, 'service', { endpoint: '/two' });
    expect(tracker.getErrors()).toHaveLength(2);
  });
  it('redacts stored text/metadata and supports silent aggregation', () => {
    const tracker = new ErrorTracker({
      logEntries: false,
      sanitizeText: (text) => text.replaceAll('secret', '[REDACTED]'),
      sanitizeMetadata: (data) => ({ ...data, token: '[REDACTED]' }),
    });
    tracker.track(new Error('secret failed'), 'service', { token: 'secret' });
    expect(tracker.getErrors()[0]).toMatchObject({
      message: '[REDACTED] failed',
      metadata: { token: '[REDACTED]' },
    });
    expect(tracker.getErrors()[0].stack).not.toContain('secret');
  });
});
