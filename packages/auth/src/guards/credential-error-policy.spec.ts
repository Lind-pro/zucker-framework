import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { createLocalAuthGuard } from './local-auth.guard';

describe('explicit credential error policies', () => {
  it('keeps anonymous optional-auth compatibility unless strict policy is requested', () => {
    expect(new OptionalJwtAuthGuard().handleRequest(new Error('invalid'), false)).toBeNull();
    const guard = new OptionalJwtAuthGuard({ invalidTokenPolicy: 'reject' });
    expect(() => guard.handleRequest(null, false)).toThrow(UnauthorizedException);
    const error = new Error('infrastructure unavailable');
    expect(() => guard.handleRequest(error, false)).toThrow(error);
    expect(guard.handleRequest(null, { id: 'fixture' })).toEqual({ id: 'fixture' });
  });
  it('allows absent credentials but validates every supplied header in strict mode', () => {
    const base = vi.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockReturnValue(false);
    try {
      const guard = new OptionalJwtAuthGuard({ invalidTokenPolicy: 'reject' });
      const context = (authorization?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }) }) as unknown as ExecutionContext;
      expect(guard.canActivate(context())).toBe(true);
      for (const header of ['', 'Basic credentials', 'Bearer', 'Bearer token extra']) {
        expect(() => guard.canActivate(context(header))).toThrow(UnauthorizedException);
      }
      expect(guard.canActivate(context('Bearer malformed'))).toBe(false);
      expect(base).toHaveBeenCalledTimes(1);
    } finally { base.mockRestore(); }
  });
  it('supports preserving strategy errors without changing legacy local-guard defaults', () => {
    const legacy = new (createLocalAuthGuard('bad credentials'))() as unknown as { handleRequest(error: Error | null, user: unknown): unknown };
    const strict = new (createLocalAuthGuard({ errorPolicy: 'preserve' }))() as unknown as typeof legacy;
    const error = new Error('storage unavailable');
    expect(() => legacy.handleRequest(error, false)).toThrow(UnauthorizedException);
    expect(() => strict.handleRequest(error, false)).toThrow(error);
    expect(() => strict.handleRequest(null, false)).toThrow(UnauthorizedException);
    expect(strict.handleRequest(null, { id: 'fixture' })).toEqual({ id: 'fixture' });
  });
});
