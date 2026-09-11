// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { AIModelCatalogService, type AIModelRecord } from './model-catalog.service';

function harness() {
  let records: AIModelRecord[] = [
    {
      id: 'old',
      name: 'Old',
      provider: 'Example',
      modelId: 'v1',
      apiKey: 'encrypted:old-key-secret',
      isDefault: true,
      isEnabled: true,
      supportsThinking: true,
      enableThinking: true,
    },
  ];
  const models = {
    findUnique: vi.fn(
      async ({ where }) =>
        records.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ??
        null,
    ),
    findMany: vi.fn(async () => records),
    count: vi.fn(async () => records.length),
    create: vi.fn(async ({ data }) => {
      const row = { id: 'new', isEnabled: true, isDefault: false, ...data } as AIModelRecord;
      records.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }) => {
      const row = records.find((row) => row.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ data }) => {
      for (const row of records) Object.assign(row, data);
      return { count: records.length };
    }),
    delete: vi.fn(),
  };
  const database: DatabaseAdapter = {
    model: () => models as unknown as ModelOperations,
    $transaction: async (work) => {
      const before = structuredClone(records);
      try {
        return await work(database);
      } catch (error) {
        records = before;
        throw error;
      }
    },
  };
  const afterChange = vi.fn();
  const service = new AIModelCatalogService({
    database,
    providers: ['Example'],
    minimumMaxTokens: 100,
    encryptSecret: (secret) => `encrypted:${secret}`,
    decryptSecret: (secret) => secret.replace(/^encrypted:/, ''),
    afterChange,
  });
  return { service, models, afterChange, records: () => records };
}

describe('model catalog credential and default contracts', () => {
  it('persists encrypted credentials, returns masks and reveals secrets only explicitly', async () => {
    const { service, models } = harness();
    const created = await service.createModel({
      name: 'New',
      provider: 'Example',
      modelId: 'v2',
      apiKey: 'new-secret-key',
      maxTokens: 1_000_000,
    });
    expect(models.create.mock.calls[0][0].data.apiKey).toBe('encrypted:new-secret-key');
    expect(created.apiKey).toBe('new-...-key');
    expect((await service.getModelById('new', true)).apiKey).toBe('new-secret-key');
    expect(
      (await service.getAllModels()).data.every((row) => !row.apiKey.startsWith('encrypted:')),
    ).toBe(true);
    expect((await service.getDefaultModel()).apiKey).not.toBe('old-key-secret');
  });
  it('validates before touching default flags and rolls them back if the replacement write fails', async () => {
    const { service, models, records, afterChange } = harness();
    await expect(service.updateModel('old', { isDefault: true, temperature: 3 })).rejects.toThrow();
    expect(models.updateMany).not.toHaveBeenCalled();
    models.create.mockRejectedValueOnce(new Error('write failed'));
    await expect(
      service.createModel({
        name: 'New',
        provider: 'Example',
        modelId: 'v2',
        apiKey: 'secret',
        isDefault: true,
      }),
    ).rejects.toThrow('write failed');
    expect(records()[0].isDefault).toBe(true);
    expect(afterChange).not.toHaveBeenCalled();
  });
  it('keeps capability toggles coherent and preserves a key when an edit leaves it empty', async () => {
    const { service } = harness();
    expect(await service.updateModel('old', { supportsThinking: false, apiKey: '' })).toMatchObject(
      { enableThinking: false },
    );
    expect((await service.getModelById('old', true)).apiKey).toBe('old-key-secret');
    expect(await service.updateModel('old', { enableThinking: true })).toMatchObject({
      enableThinking: false,
    });
    expect(
      await service.updateModel('old', { supportsThinking: true, enableThinking: true }),
    ).toMatchObject({ enableThinking: true });
  });
  it('rejects default deletion, disabled defaults and arbitrary write fields', async () => {
    const { service } = harness();
    await expect(service.deleteModel('old')).rejects.toThrow();
    await expect(service.updateModel('old', { isEnabled: false })).rejects.toThrow();
    await expect(service.updateModel('old', { id: 'different' })).rejects.toThrow();
    expect(await service.testModelConnection('old')).toMatchObject({ success: false });
  });
});
