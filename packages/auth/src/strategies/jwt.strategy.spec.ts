// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JwtStrategy, JwtStrategyBase } from './jwt.strategy';

interface Claims {
  sub: string;
  tokenType: string;
}
class AsyncIdentityStrategy extends JwtStrategyBase<Claims> {
  async validate(payload: Claims): Promise<{ id: string; roles: string[] }> {
    return { id: payload.sub, roles: ['member'] };
  }
}
describe('JWT strategy extension contract', () => {
  it('allows typed asynchronous identity validation without a constructor cast', async () => {
    const strategy = new AsyncIdentityStrategy('synthetic-secret');
    expect(await strategy.validate({ sub: 'user', tokenType: 'access' })).toEqual({
      id: 'user',
      roles: ['member'],
    });
  });
  it('preserves the synchronous default identity mapping', () => {
    const strategy = new JwtStrategy('synthetic-secret');
    expect(strategy.validate({ sub: 'user', username: 'test', role: 'member' })).toEqual({
      id: 'user',
      username: 'test',
      role: 'member',
    });
  });
});
