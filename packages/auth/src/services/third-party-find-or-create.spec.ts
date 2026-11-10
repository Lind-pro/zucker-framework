import { describe, expect, it, vi } from 'vitest';
import { ThirdPartyAccountService } from './third-party-account.service';

function database(existingUser: Record<string, unknown> | null) {
  const users = { findUnique: vi.fn().mockResolvedValue(existingUser), create: vi.fn().mockResolvedValue({ id: 'new-user' }) };
  const binds = { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn() };
  const model = (name: string) => (name === 'users' ? users : binds);
  const db = { model, $transaction: async (work: (tx: unknown) => unknown) => work({ model }) };
  return { db, users, binds };
}

describe('ThirdPartyAccountService.findOrCreateUser (H5)', () => {
  it('refuses to link an existing account on an unverified provider email', async () => {
    const { db, binds } = database({ id: 'victim', emailVerified: true });
    const service = new ThirdPartyAccountService(db as never);
    await expect(service.findOrCreateUser('github', { providerAccountId: '1', email: 'victim@example.test' }))
      .rejects.toMatchObject({ code: 'THIRD_PARTY_EMAIL_UNVERIFIED' });
    await expect(service.findOrCreateUser('github', { providerAccountId: '1', email: 'victim@example.test', emailVerified: false }))
      .rejects.toMatchObject({ code: 'THIRD_PARTY_EMAIL_UNVERIFIED' });
    expect(binds.create).not.toHaveBeenCalled();
  });

  it('refuses to link into a local account whose email is not verified', async () => {
    const { db } = database({ id: 'squatter', emailVerified: false });
    const service = new ThirdPartyAccountService(db as never);
    await expect(service.findOrCreateUser('google', { providerAccountId: '1', email: 'v@example.test', emailVerified: true }))
      .rejects.toMatchObject({ code: 'THIRD_PARTY_EMAIL_IN_USE' });
  });

  it('links when both sides are verified', async () => {
    const { db, binds } = database({ id: 'owner', emailVerified: true });
    const service = new ThirdPartyAccountService(db as never);
    await expect(service.findOrCreateUser('google', { providerAccountId: '1', email: 'o@example.test', emailVerified: true }))
      .resolves.toEqual({ userId: 'owner', isNew: false });
    expect(binds.create).toHaveBeenCalled();
  });

  it('creates new users with a provider-derived username and unverified email by default', async () => {
    const { db, users, binds } = database(null);
    const service = new ThirdPartyAccountService(db as never);
    await expect(service.findOrCreateUser('github', { providerAccountId: '42', email: 'n@example.test', displayName: 'admin' }))
      .resolves.toEqual({ userId: 'new-user', isNew: true });
    expect(users.create.mock.calls[0][0].data).toMatchObject({ username: 'github_42', name: 'admin', emailVerified: false });
    expect(binds.create.mock.calls[0][0].data).toMatchObject({ userId: 'new-user', provider: 'github', providerAccountId: '42' });
  });

  it('returns the winner of a concurrent first login', async () => {
    const { db, users, binds } = database(null);
    users.create.mockRejectedValueOnce(new Error('unique violation'));
    binds.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'b', userId: 'winner' });
    const service = new ThirdPartyAccountService(db as never);
    await expect(service.findOrCreateUser('github', { providerAccountId: '42' })).resolves.toEqual({ userId: 'winner', isNew: false });
  });
});
