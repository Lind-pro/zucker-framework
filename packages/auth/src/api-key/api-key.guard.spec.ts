import { EventEmitter } from 'node:events';
import { Logger, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeyService } from './api-key.service';

function harness(headers: Record<string, string | undefined> = {}) {
  const keys = {
    options: { keyPrefix: 'test_' },
    validateApiKey: vi.fn().mockResolvedValue({ isValid: true, keyId: 'key-1', userId: 'owner', scopes: ['read'] }),
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date(60000) }),
    logUsage: vi.fn().mockResolvedValue(undefined),
  };
  const request = { headers, path: '/resource', method: 'GET', user: undefined, apiKey: undefined, query: { api_key: 'test_query-secret' } };
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), statusCode: 200 });
  const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ExecutionContext;
  const guard = new ApiKeyGuard(keys as unknown as ApiKeyService, { allowMissingKey: true });
  return { guard, keys, request, response, context };
}

afterEach(() => vi.restoreAllMocks());

describe('ApiKeyGuard header transport', () => {
  it('leaves JWT fallback available and never reads secrets from query strings', async () => {
    const { guard, keys, context } = harness({ authorization: 'Bearer jwt-token' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(keys.validateApiKey).not.toHaveBeenCalled();
  });

  it.each([{ authorization: 'Bearer test_secret' }, { 'x-api-key': 'test_secret' }])(
    'authenticates header credentials and exposes rate-limit headers: %o', async headers => {
      const { guard, keys, context, request, response } = harness(headers);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(keys.validateApiKey).toHaveBeenCalledWith('test_secret');
      expect(request.user).toEqual({ id: 'owner' });
      expect(request.apiKey).toEqual({ id: 'key-1', scopes: ['read'] });
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 4);
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', new Date(60000).toISOString());
    },
  );

  it('denies exhausted keys before injecting identity or logging successful usage', async () => {
    const { guard, keys, context, request, response } = harness({ 'x-api-key': 'test_secret' });
    keys.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
    expect(response.listenerCount('finish')).toBe(0);
  });

  it('contains best-effort audit failures without logging raw secret-bearing errors', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { guard, keys, context, response } = harness({ 'x-api-key': 'test_secret' });
    keys.logUsage.mockRejectedValue(new Error('test_secret private database failure'));
    await guard.canActivate(context);
    response.emit('finish');
    await Promise.resolve();
    expect(keys.logUsage).toHaveBeenCalledWith('key-1', 'owner', '/resource', 'GET', 200, expect.any(Number));
    expect(warn).toHaveBeenCalledWith('API key usage persistence failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('test_secret');
  });
});
