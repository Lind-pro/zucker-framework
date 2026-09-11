// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { RejectedRequestLoggerMiddleware } from './rejected-request-logger.middleware';
import { ZuckerLoggingModule } from './logging.module';

describe('rejected-request persistence', () => {
  it('captures identity and final status after guards run, with configured client-IP retention', () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const middleware = new RejectedRequestLoggerMiddleware({ log } as never, {
      retainClientIp: true,
    });
    let finish = () => {};
    const request = {
      path: '/private',
      url: '/private',
      method: 'GET',
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
      expect.objectContaining({ action: 'http:403', userId: 'synthetic-user', ip: '192.0.2.2' }),
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
    response.statusCode = 404;
    finish();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'http:404', ip: undefined }),
    );
    expect(() => ZuckerLoggingModule.forRoot({ rejectedRequests: {} })).toThrow(
      'requires persistence',
    );
  });
});
