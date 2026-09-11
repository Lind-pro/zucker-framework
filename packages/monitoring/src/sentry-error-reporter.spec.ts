import { describe, expect, it, vi } from 'vitest';
import { SentryErrorReporter, type SentryEvent, type SentrySdkPort } from './sentry-error-reporter';

describe('configured Sentry adapter', () => {
  it('does not load the SDK when unconfigured and initializes it only once when enabled', async () => {
    const loadSdk = vi.fn();
    const disabled = new SentryErrorReporter({ loadSdk });
    disabled.captureMessage('ignored');
    await disabled.onModuleInit();
    expect(loadSdk).not.toHaveBeenCalled();
    const sdk = { init: vi.fn() } as unknown as SentrySdkPort;
    loadSdk.mockResolvedValue(sdk);
    const enabled = new SentryErrorReporter({ dsn: 'https://synthetic.invalid', loadSdk });
    await Promise.all([enabled.onModuleInit(), enabled.onModuleInit()]);
    expect(loadSdk).toHaveBeenCalledOnce();
    expect(sdk.init).toHaveBeenCalledOnce();
  });
  it('redacts only selected event sections without mutation and maps per-call context', async () => {
    let beforeSend!: (event: SentryEvent) => SentryEvent | null;
    const scope = { setTag: vi.fn(), setUser: vi.fn(), setExtra: vi.fn() };
    const sdk: SentrySdkPort = {
      init: (options) => {
        beforeSend = options.beforeSend;
      },
      withScope: (callback) => callback(scope),
      captureMessage: vi.fn(),
      captureException: vi.fn(),
      setUser: vi.fn(),
    };
    const reporter = new SentryErrorReporter({
      dsn: 'https://synthetic.invalid',
      loadSdk: async () => sdk,
      redaction: { fields: ['privateText'], sections: ['request', 'extra'] },
      mapContext: (context, kind) => ({
        tags: { trace: context.requestId ?? '', kind },
        extra: { resourceId: context.resourceId },
      }),
    });
    await reporter.onModuleInit();
    const source = {
      request: { data: { privateText: 'secret', visible: 1 } },
      extra: [{ privateText: 'secret' }],
      untouched: { privateText: 'retained' },
    };
    expect(beforeSend(source)).toEqual({
      request: { data: { privateText: '[Redacted]', visible: 1 } },
      extra: [{ privateText: '[Redacted]' }],
      untouched: { privateText: 'retained' },
    });
    expect(source.request.data.privateText).toBe('secret');
    reporter.captureException(new Error('example'), { requestId: 'trace', resourceId: 'record' });
    expect(scope.setTag).toHaveBeenCalledWith('kind', 'exception');
    expect(scope.setExtra).toHaveBeenCalledWith('resourceId', 'record');
    expect(sdk.captureException).toHaveBeenCalledOnce();
  });
});
