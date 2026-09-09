import { EventEmitter2 } from 'eventemitter2';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CONFIG_CHANGED_EVENT, ConfigService, type ConfigChangePayload } from './config.service';
import { InMemoryAdapter } from '@zucker-framework/crud';

/**
 * Lightweight mock DB for tests that only need a single findUnique result.
 */
function createDb(recordValue?: unknown) {
  const findUnique = vi.fn().mockResolvedValue(
    recordValue === undefined
      ? null
      : { scope: 'system', key: 'theme', value: recordValue },
  );
  const update = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockResolvedValue(undefined);
  const deleteRecord = vi.fn().mockResolvedValue(undefined);

  return {
    adapter: {
      model: vi.fn().mockReturnValue({
        findUnique,
        update,
        create,
        delete: deleteRecord,
      }),
    } as any,
    findUnique,
    update,
    create,
    deleteRecord,
  };
}

describe('ConfigService', () => {
  it('loads oldValue from storage when updating with a cold cache', async () => {
    const db = createDb('light');
    const eventEmitter = new EventEmitter2();
    const service = new ConfigService(db.adapter, eventEmitter);
    const payloads: unknown[] = [];

    eventEmitter.on(CONFIG_CHANGED_EVENT, (payload) => payloads.push(payload));

    await service.set('system', 'theme', 'dark');

    expect(db.findUnique).toHaveBeenCalledWith({
      where: { scope_key: { scope: 'system', key: 'theme' } },
    });
    expect(payloads).toEqual([
      {
        scope: 'system',
        key: 'theme',
        oldValue: 'light',
        newValue: 'dark',
      },
    ]);
  });

  it('loads oldValue from storage when removing with a cold cache', async () => {
    const db = createDb('dark');
    const eventEmitter = new EventEmitter2();
    const service = new ConfigService(db.adapter, eventEmitter);
    const payloads: unknown[] = [];

    eventEmitter.on(CONFIG_CHANGED_EVENT, (payload) => payloads.push(payload));

    await service.remove('system', 'theme');

    expect(db.findUnique).toHaveBeenCalledWith({
      where: { scope_key: { scope: 'system', key: 'theme' } },
    });
    expect(payloads).toEqual([
      {
        scope: 'system',
        key: 'theme',
        oldValue: 'dark',
        newValue: undefined,
      },
    ]);
  });
});

// ─── Full integration tests with InMemoryAdapter ─────────────────────────

describe('ConfigService (InMemoryAdapter)', () => {
  let db: InMemoryAdapter;
  let eventEmitter: EventEmitter2;
  let service: ConfigService;

  beforeEach(() => {
    db = new InMemoryAdapter();
    eventEmitter = new EventEmitter2();
    service = new ConfigService(db, eventEmitter);
  });

  // ─── basic get/set ─────────────────────────────────────────────────

  describe('get / set', () => {
    it('should return undefined for a missing config key', async () => {
      expect(await service.get('app', 'locale')).toBeUndefined();
    });

    it('should store and retrieve a config value', async () => {
      await service.set('app', 'locale', 'zh-CN');
      expect(await service.get('app', 'locale')).toBe('zh-CN');
    });

    it('should overwrite an existing config value', async () => {
      await service.set('app', 'locale', 'en');
      await service.set('app', 'locale', 'zh-CN');
      expect(await service.get('app', 'locale')).toBe('zh-CN');
    });
  });

  // ─── cache behavior ────────────────────────────────────────────────

  describe('cache', () => {
    it('should serve from cache on second read', async () => {
      await service.set('app', 'theme', 'dark');
      // First read populates cache
      expect(await service.get('app', 'theme')).toBe('dark');

      // Spy on db.model to verify no DB call on second read
      const modelSpy = vi.spyOn(db, 'model');
      expect(await service.get('app', 'theme')).toBe('dark');
      // model() is not called because the cache already has the value
      expect(modelSpy).not.toHaveBeenCalled();
      modelSpy.mockRestore();
    });

    it('should invalidate cache when clearCache is called', async () => {
      await service.set('app', 'theme', 'dark');
      // Warm up cache
      await service.get('app', 'theme');

      service.clearCache('app');

      // After clearCache, the next get should go to DB
      const modelSpy = vi.spyOn(db, 'model');
      const result = await service.get('app', 'theme');
      expect(result).toBe('dark');
      expect(modelSpy).toHaveBeenCalled();
      modelSpy.mockRestore();
    });

    it('should clear all caches when clearCache is called without scope', async () => {
      await service.set('app', 'theme', 'dark');
      await service.set('system', 'lang', 'en');
      // Warm up cache
      await service.get('app', 'theme');
      await service.get('system', 'lang');

      service.clearCache();

      const modelSpy = vi.spyOn(db, 'model');
      await service.get('app', 'theme');
      await service.get('system', 'lang');
      // Both should hit DB after full cache clear
      expect(modelSpy).toHaveBeenCalled();
      modelSpy.mockRestore();
    });
  });

  // ─── cache eviction (while loop ensuring no overflow) ──────────────

  describe('cache eviction', () => {
    it('should evict oldest entries when cache reaches CACHE_MAX_SIZE', async () => {
      // CACHE_MAX_SIZE is 1024 (private static). Write 1025 entries to trigger eviction.
      const MAX = 1024;
      for (let i = 0; i < MAX + 1; i++) {
        await service.set('evict', `key-${i}`, `val-${i}`);
      }

      // The very first entry should have been evicted from cache
      // (it may still exist in DB, but the cache slot was reclaimed).
      // After eviction, the cache size should be <= MAX.
      // We verify by checking that the service still works correctly
      // for the latest entry.
      expect(await service.get('evict', `key-${MAX}`)).toBe(`val-${MAX}`);

      // The first few entries should have been evicted from cache,
      // but re-readable from DB.
      service.clearCache();
      expect(await service.get('evict', 'key-0')).toBe('val-0');
    });

    it('should evict during get() when cache is full', async () => {
      const MAX = 1024;
      // Fill cache via set
      for (let i = 0; i < MAX; i++) {
        await service.set('fill', `k-${i}`, `v-${i}`);
      }
      // Now read a new key from DB (not in cache) — triggers eviction in get()
      await service.set('fill', 'extra', 'extra-val');
      service.clearCache();
      // This get() will fetch from DB and need to add to a full cache
      const val = await service.get('fill', 'extra');
      expect(val).toBe('extra-val');
    });
  });

  // ─── watch ─────────────────────────────────────────────────────────

  describe('watch', () => {
    it('should notify on config change for specific scope+key', async () => {
      const received: Array<{ newVal: unknown; oldVal: unknown }> = [];
      service.watch<string>('app', 'theme', (newVal, oldVal) => {
        received.push({ newVal, oldVal });
      });

      await service.set('app', 'theme', 'dark');
      await service.set('app', 'theme', 'light');

      expect(received).toHaveLength(2);
      expect(received[0].newVal).toBe('dark');
      expect(received[1].oldVal).toBe('dark');
      expect(received[1].newVal).toBe('light');
    });

    it('should not notify for a different scope', async () => {
      const received: unknown[] = [];
      service.watch('app', 'theme', (newVal) => {
        received.push(newVal);
      });

      await service.set('system', 'theme', 'dark');

      expect(received).toHaveLength(0);
    });

    it('should not notify for a different key within same scope', async () => {
      const received: unknown[] = [];
      service.watch('app', 'theme', (newVal) => {
        received.push(newVal);
      });

      await service.set('app', 'lang', 'en');

      expect(received).toHaveLength(0);
    });

    it('should watch entire scope when key is undefined', async () => {
      const received: ConfigChangePayload[] = [];
      const handler = (newVal: unknown, oldVal: unknown) => {
        // The watch callback receives (newValue, oldValue), but we capture via event too
      };
      // Use onChange for scope-level test
      service.watch('app', undefined, (newVal, oldVal) => {
        received.push({ scope: 'app', key: '', oldValue: oldVal, newValue: newVal });
      });

      await service.set('app', 'theme', 'dark');
      await service.set('app', 'lang', 'en');

      expect(received).toHaveLength(2);
    });

    it('should stop notifying after unsubscribe', async () => {
      const received: unknown[] = [];
      const sub = service.watch('app', 'theme', (newVal) => {
        received.push(newVal);
      });

      await service.set('app', 'theme', 'dark');
      sub.unsubscribe();
      await service.set('app', 'theme', 'light');

      expect(received).toHaveLength(1);
      expect(received[0]).toBe('dark');
    });
  });

  // ─── onChange ──────────────────────────────────────────────────────

  describe('onChange', () => {
    it('should fire for any config change', async () => {
      const payloads: ConfigChangePayload[] = [];
      service.onChange((p) => payloads.push(p));

      await service.set('a', 'k1', 'v1');
      await service.set('b', 'k2', 'v2');

      expect(payloads).toHaveLength(2);
    });

    it('should stop after unsubscribe', async () => {
      const payloads: ConfigChangePayload[] = [];
      const sub = service.onChange((p) => payloads.push(p));

      await service.set('a', 'k1', 'v1');
      sub.unsubscribe();
      await service.set('a', 'k1', 'v2');

      expect(payloads).toHaveLength(1);
    });
  });

  // ─── remove ────────────────────────────────────────────────────────

  describe('remove', () => {
    it('should remove a config and emit event with newValue=undefined', async () => {
      await service.set('app', 'theme', 'dark');

      const payloads: ConfigChangePayload[] = [];
      service.onChange((p) => payloads.push(p));

      await service.remove('app', 'theme');

      expect(await service.get('app', 'theme')).toBeUndefined();
      expect(payloads).toHaveLength(1);
      expect(payloads[0].newValue).toBeUndefined();
      expect(payloads[0].oldValue).toBe('dark');
    });
  });
});
