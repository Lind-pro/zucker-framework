import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { ApiKeyService, type ApiKeyRecord } from './api-key.service';

function harness(overrides: Partial<ApiKeyRecord> = {}) {
  const record: ApiKeyRecord = {
    id: 'key-1', userId: 'owner', name: 'integration', keyPrefix: 'test_prefix...',
    keyHash: createHash('sha256').update('test_secret').digest('hex'),
    scopes: ['read'], rateLimit: 5, dailyLimit: null, monthlyLimit: null,
    expiresAt: null, revokedAt: null, isActive: true, lastUsedAt: null,
    usageCount: 0, createdAt: new Date(), ...overrides,
  };
  const keys = {
    create: vi.fn(async ({ data }: { data: Partial<ApiKeyRecord> }) => ({ ...record, ...data })),
    findMany: vi.fn().mockResolvedValue([record]),
    findUnique: vi.fn().mockResolvedValue(record),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi.fn().mockResolvedValue(record),
  };
  const usage = { create: vi.fn().mockResolvedValue({ id: 'usage' }) };
  const db = { model: vi.fn((name: string) => name === 'keys' ? keys : usage) } as unknown as DatabaseAdapter;
  const consumeRateLimit = vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() });
  const service = new ApiKeyService(db, {
    modelName: 'keys', usageModelName: 'usages', keyPrefix: 'test_',
    defaultScopes: ['read'], defaultRateLimit: 5, consumeRateLimit,
  });
  return { service, record, keys, usage, consumeRateLimit };
}

describe('ApiKeyService persistent authentication', () => {
  it('returns a random secret once and stores only its SHA-256 digest', async () => {
    const { service, keys } = harness();
    const result = await service.createApiKey({ userId: 'owner', name: 'client' });
    expect(result.secretKey).toMatch(/^test_[A-Za-z0-9_-]{32}$/);
    expect(keys.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      keyHash: createHash('sha256').update(result.secretKey).digest('hex'),
      userId: 'owner', scopes: ['read'], rateLimit: 5,
    }) });
    expect(result.apiKey).not.toHaveProperty('keyHash');
    expect(JSON.stringify(keys.create.mock.calls)).not.toContain(result.secretKey);
  });

  it.each([
    { isActive: false }, { revokedAt: new Date() }, { expiresAt: new Date(Date.now() - 1000) },
  ])('rejects disabled, revoked or expired keys before recording usage: %o', async state => {
    const { service, keys } = harness(state);
    await expect(service.validateApiKey('test_secret')).resolves.toMatchObject({ isValid: false });
    expect(keys.updateMany).not.toHaveBeenCalled();
  });

  it('does not accept a key revoked between its lookup and usage touch', async () => {
    const { service, keys } = harness();
    keys.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.validateApiKey('test_secret')).resolves.toMatchObject({ isValid: false });
    expect(keys.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'key-1', isActive: true, revokedAt: null }),
      data: { lastUsedAt: expect.any(Date), usageCount: { increment: 1 } },
    });
  });

  it('returns identity/scopes for a live key and applies its persisted rate limit', async () => {
    const { service, consumeRateLimit } = harness();
    await expect(service.validateApiKey('test_secret')).resolves.toEqual({
      isValid: true, userId: 'owner', keyId: 'key-1', scopes: ['read'],
    });
    await service.checkRateLimit('key-1');
    expect(consumeRateLimit).toHaveBeenCalledWith('key-1', 5);
  });

  it('never reads key data or changes a key for a different owner', async () => {
    const { service, keys } = harness();
    await expect(service.getApiKey('key-1', 'other')).rejects.toThrow('API key not found');
    await expect(service.updateApiKey('key-1', 'other', { name: 'changed' })).rejects.toThrow();
    await expect(service.revokeApiKey('key-1', 'other')).rejects.toThrow();
    expect(keys.update).not.toHaveBeenCalled();
  });

  it('includes the owner in the final revocation write', async () => {
    const { service, keys } = harness();
    await service.revokeApiKey('key-1', 'owner');
    expect(keys.update).toHaveBeenCalledWith({
      where: { id: 'key-1', userId: 'owner' },
      data: { isActive: false, revokedAt: expect.any(Date) },
    });
  });
});
