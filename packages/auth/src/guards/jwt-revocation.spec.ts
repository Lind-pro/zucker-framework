import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from '../services/token.service';

function context(authorization: string): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers: { authorization }, user: { id: 'owner' } }) }),
    getHandler: () => () => {}, getClass: () => class {} } as unknown as ExecutionContext;
}
describe('JWT blacklist credential binding', () => {
  it('rejects revoked stateless JWTs with no cache after successful Passport validation', async () => {
    const base = vi.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true);
    try {
      const tokens = new TokenService();
      const guard = new JwtAuthGuard(new Reflector(), tokens);
      await tokens.revokeToken('signed-token');
      await expect(guard.canActivate(context('Bearer signed-token'))).rejects.toThrow('Token 已被撤销');
      expect(() => guard.canActivate(context('Bearer signed-token extra'))).toThrow('Invalid authorization header');
      expect(base).toHaveBeenCalledTimes(1);
    } finally { base.mockRestore(); }
  });
});
