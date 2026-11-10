import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { DictionaryService } from './dictionary.service';

function harness(failItemFor?: string) {
  const dictionaries = new Map<string, Record<string, unknown>>([['old', { id: 'old', name: 'Old' }]]);
  const model = (name: string) => ({
    findUnique: async ({ where }: { where: { id: string } }) => dictionaries.get(where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      dictionaries.set(where.id, { ...dictionaries.get(where.id), ...data });
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (name === 'dictionaryItem' && data.dictId === failItemFor) throw new Error('item insert failed');
      if (name === 'dictionary') dictionaries.set(data.id as string, data);
    },
    deleteMany: async () => ({ count: 0 }),
  });
  const db = {
    model,
    $transaction: async <T>(work: (tx: DatabaseAdapter) => Promise<T>) => work({ model } as unknown as DatabaseAdapter),
  } as unknown as DatabaseAdapter;
  const emitter = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { service: new DictionaryService(db, emitter as never), emitter };
}

describe('DictionaryService.importDictionaries', () => {
  it('counts a failed entry only as failed and notifies changes for committed entries', async () => {
    const { service, emitter } = harness('broken');
    const clear = vi.spyOn(service, 'clearCache');

    const result = await service.importDictionaries([
      { dictionary: { id: 'old', name: 'Renamed' }, items: [] },
      { dictionary: { id: 'new', name: 'New' }, items: [{ value: '1' }] },
      { dictionary: { id: 'broken', name: 'Broken' }, items: [{ value: '1' }] },
    ]);

    expect(result).toEqual({ imported: 1, updated: 1, failed: 1 });
    expect(clear).toHaveBeenCalledWith('old');
    expect(clear).toHaveBeenCalledWith('new');
    expect(clear).not.toHaveBeenCalledWith('broken');
    expect(emitter.emit).toHaveBeenCalledWith('zucker.dictionary-changed', { type: 'updated', dictId: 'old' });
  });
});
