import { describe, it, expect, vi } from 'vitest';
import { ThirdPartyAccountService } from './third-party-account.service';

describe('configured third-party bindings', () => {
  it('uses the locked transaction for duplicate-provider checks and does not merge users by email', async () => {
    const root = { model: vi.fn() };
    const model = { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([{ id: 'existing' }]), create: vi.fn() };
    const tx = { model: vi.fn().mockReturnValue(model) };
    const locked = vi.fn(async (_user, work) => work(tx));
    const service = new ThirdPartyAccountService(root as never, {
      bindingsModel: 'bindings', rejectDuplicateProvider: true, withUserLock: locked,
    });
    await expect(service.bindAccount('u', 'p', { providerAccountId: 'a', email: 'same@example.test' }))
      .rejects.toMatchObject({ code: 'THIRD_PARTY_PROVIDER_BOUND' });
    expect(root.model).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
    expect(tx.model).toHaveBeenCalledWith('bindings');
  });
  it('refuses to remove the last passwordless login method inside the lock', async () => {
    const remove = vi.fn();
    const tx = { model: vi.fn((name) => name === 'accounts'
      ? { findUnique: vi.fn().mockResolvedValue({ password: null }) }
      : { findMany: vi.fn().mockResolvedValue([{ id: 'b', provider: 'p' }]), delete: remove }) };
    const service = new ThirdPartyAccountService({} as never, {
      bindingsModel: 'bindings', usersModel: 'accounts',
      withUserLock: (_user, work) => work(tx as never),
    });
    await expect(service.unbindAccount('u', 'p')).rejects.toMatchObject({ code: 'CANNOT_UNBIND_LAST_LOGIN' });
    expect(remove).not.toHaveBeenCalled();
  });
});
