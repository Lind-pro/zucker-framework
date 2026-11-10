// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { RejectedRequestLoggerMiddleware } from './rejected-request-logger.middleware';
import { ZuckerLoggingModule } from './logging.module';

describe('rejected-request persistence', () => {
  it('captures identity and final status after guards run, retaining only the transport client IP', () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const middleware = new RejectedRequestLoggerMiddleware({ log } as never, {
      retainClientIp: true,
    });
    let finish = () => {};
    const request = {
      path: '/private',
      url: '/private',
      method: 'GET',
      ip: '198.51.100.7',
      // Client-controlled; must not replace request.ip (trust proxy is the app's decision).
      headers: { 'x-forwarded-for': '192.0.2.2, 192.0.2.3' },
      user: undefined as { id: string } | undefined,
    };
    const response = {
      statusCode: 200,
      on: (_event: string, listener: () => void) => {
        finish = listener;
      },
    };
    const next = vi.fn();
    middleware.use(request, response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    request.user = { id: 'synthetic-user' };
    response.statusCode = 403;
    finish();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'http:403', userId: 'synthetic-user', ip: '198.51.100.7', exception: 'HTTP 403', statusCode: 403 }),
      { completionObservation: undefined, completionResponse: undefined },
    );
  });
  it('skips configured routes and successes, and omits IPs by default', () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const middleware = new RejectedRequestLoggerMiddleware({ log } as never, {
      skipPaths: ['/health'],
    });
    let finish = () => {};
    const response = {
      statusCode: 200,
      on: vi.fn((_event: string, listener: () => void) => {
        finish = listener;
      }),
    };
    middleware.use(
      { path: '/health', url: '/health', method: 'GET', headers: {} },
      response,
      () => {},
    );
    expect(response.on).not.toHaveBeenCalled();
    middleware.use(
      { path: '/other', url: '/other', method: 'GET', headers: {}, ip: '192.0.2.2' },
      response,
      () => {},
    );
    finish();
    expect(log).not.toHaveBeenCalled();
    // A new request has its own final status; completion is never recorded twice.
    middleware.use(
      { path: '/other', url: '/other', method: 'GET', headers: {}, ip: '192.0.2.2' },
      response,
      () => {},
    );
    response.statusCode = 404;
    finish();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'http:404', ip: undefined }),
      { completionObservation: undefined, completionResponse: undefined },
    );
    expect(() => ZuckerLoggingModule.forRoot({ rejectedRequests: {} })).toThrow(
      'requires persistence',
    );
  });

  it('rate-limits persisted rejections per status and client by default', () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const middleware = new RejectedRequestLoggerMiddleware({ log } as never, {
      rateLimit: { maxPerKey: 3, maxTotal: 5, windowMs: 60_000 },
    });
    const hit = (ip: string, status = 404) => {
      let finish = () => {};
      const response = { statusCode: status, on: (_e: string, l: () => void) => { finish = l; } };
      middleware.use({ path: `/x${Math.random()}`, url: '/x', method: 'GET', headers: {}, ip }, response, () => {});
      finish();
    };
    for (let i = 0; i < 10; i += 1) hit('192.0.2.10');
    expect(log).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 10; i += 1) hit(`192.0.2.${20 + i}`);
    expect(log).toHaveBeenCalledTimes(5);

    const unlimited = vi.fn().mockResolvedValue(undefined);
    const open = new RejectedRequestLoggerMiddleware({ log: unlimited } as never, { rateLimit: false });
    for (let i = 0; i < 30; i += 1) {
      let finish = () => {};
      open.use({ path: '/y', url: '/y', method: 'GET', headers: {}, ip: '192.0.2.1' }, {
        statusCode: 404, on: (_e: string, l: () => void) => { finish = l; },
      }, () => {});
      finish();
    }
    expect(unlimited).toHaveBeenCalledTimes(30);
  });
});
