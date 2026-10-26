import { describe, expect, it, vi } from 'vitest';
import { ThirdPartyAccountController } from './third-party-account.controller';
import { ThirdPartyAccountService } from '../services/third-party-account.service';

const request = { user: { id: 'current-user', sessionId: 'current-session' }, headers: { cookie: 'browser=synthetic' } };
const proof = 'p'.repeat(43);

describe('third-party HTTP binding proof boundary', () => {
  it('rejects raw client profiles and unconfigured proof resolution before any database action', async () => {
    const model = vi.fn(), transaction = vi.fn();
    const service = new ThirdPartyAccountService({ model, $transaction: transaction } as never);
    const controller = new ThirdPartyAccountController(service);
    await expect(controller.bind(request, 'google', { providerAccountId: 'victim-id', email: 'victim@example.test' })).rejects.toThrow('proof');
    await expect(controller.bind(request, 'google', { proof })).rejects.toThrow('proof');
    expect(model).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
  });

  it('binds only the resolver projection for the authenticated subject, ignoring client profile fields', async () => {
    const create = vi.fn();
    const model = { findUnique: vi.fn().mockResolvedValue(null), create };
    const tx = { model: vi.fn().mockReturnValue(model) };
    const resolver = vi.fn(async () => ({ providerAccountId: 'verified-subject', email: 'verified@example.test' }));
    const service = new ThirdPartyAccountService({ $transaction: (work: (db: unknown) => Promise<void>) => work(tx) } as never,
      { resolveBindingProof: resolver });
    const controller = new ThirdPartyAccountController(service);
    await expect(controller.bind(request, 'google', { proof, providerAccountId: 'victim-id', userId: 'victim-user' })).resolves.toEqual({ success: true });
    expect(resolver).toHaveBeenCalledWith({ userId: 'current-user', provider: 'google', proof, request });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'current-user', provider: 'google', providerAccountId: 'verified-subject' }) });
    expect(JSON.stringify(create.mock.calls)).not.toContain('victim');
  });

  it('does not perform a binding write when proof validation fails', async () => {
    const transaction = vi.fn(); const resolver = vi.fn().mockRejectedValue(new Error('invalid proof context'));
    const controller = new ThirdPartyAccountController(new ThirdPartyAccountService({ $transaction: transaction } as never,
      { resolveBindingProof: resolver }));
    await expect(controller.bind(request, 'github', { proof })).rejects.toThrow('invalid proof context');
    expect(transaction).not.toHaveBeenCalled();
  });
});
