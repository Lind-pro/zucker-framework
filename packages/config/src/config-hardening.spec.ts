import { randomBytes } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { SecretCipher, type DatabaseAdapter } from '@zucker-framework/core';
import { ConfigScopeManager } from './config-scope-manager';
import { LayeredConfigService, LAYERED_CONFIG_CHANGED_TOPIC, type LayeredConfigChangePayload } from './layered-config.service';
import { ConfigService, CONFIG_CHANGED_TOPIC } from './config.service';
import { ConfigFileWatcher } from './config-watcher';

function scopes() {
  const manager = new ConfigScopeManager();
  manager.register({ id: 'app', name: 'App', isPublic: false, publicAccess: false, properties: [
    { key: 'theme', name: 'theme', type: 'string', defaultValue: 'light', description: '', readonly: false },
    { key: 'apiKey', name: 'apiKey', type: 'string', defaultValue: undefined, description: '', readonly: false, encrypted: true },
  ] });
  return manager;
}

/** Synthetic in-process bus that delivers to subscribers like a distributed bus would. */
function bus() {
  const handlers = new Map<string, Array<(m: { payload: unknown }) => void>>();
  return {
    publish: vi.fn(async (topic: string, payload: unknown) => {
      for (const h of handlers.get(topic) ?? []) h({ payload });
    }),
    subscribe: vi.fn((topic: string, handler: (m: { payload: unknown }) => void) => {
      handlers.set(topic, [...(handlers.get(topic) ?? []), handler]);
      return { unsubscribe: () => undefined };
    }),
  };
}

afterEach(() => vi.useRealTimers());

describe('LayeredConfigService', () => {
  it('H8: set() serves the new value immediately after the cache was warmed', async () => {
    const service = new LayeredConfigService(new InMemoryAdapter(), scopes());
    await service.set('app', 'theme', 'v1', 'tenant', 't1');
    expect(await service.get('app', 'theme', { tenantId: 't1' })).toBe('v1');
    await service.set('app', 'theme', 'v2', 'tenant', 't1');
    expect(await service.get('app', 'theme', { tenantId: 't1' })).toBe('v2');
  });

  it('M17: a rolled-back batch leaves the cache untouched', async () => {
    const db = new InMemoryAdapter();
    const service = new LayeredConfigService(db, scopes());
    await service.set('app', 'theme', 'committed', 'system');
    const failing = Object.create(db) as DatabaseAdapter;
    failing.$transaction = (async (fn: (tx: DatabaseAdapter) => Promise<unknown>) => {
      await fn(db);
      throw new Error('commit failure');
    }) as DatabaseAdapter['$transaction'];
    const other = new LayeredConfigService(failing, scopes());
    expect(await other.get('app', 'theme')).toBe('committed');
    await db.model('config').update({ where: { scope_key: { scope: 'app@system', key: 'theme' } }, data: { value: 'committed' } });
    await expect(other.setProperties('app', { theme: 'uncommitted' }, 'system')).rejects.toThrow('commit failure');
    expect(await other.get('app', 'theme')).toBe('committed');
  });

  it('M17: encrypted properties are stored encrypted, decrypted on read and redacted in events', async () => {
    const db = new InMemoryAdapter();
    const encryptor = new SecretCipher({ masterKey: randomBytes(32).toString('hex') });
    const b = bus();
    const service = new LayeredConfigService(db, scopes(), undefined, b, encryptor);
    await service.set('app', 'apiKey', 'SYNTHETIC-SECRET', 'user', 'u1');
    service.clearCache();
    expect(await service.get('app', 'apiKey', { userId: 'u1' })).toBe('SYNTHETIC-SECRET');
    expect(await service.getAll('app', { userId: 'u1' })).toMatchObject({ apiKey: 'SYNTHETIC-SECRET' });
    const sinks = JSON.stringify([await db.model('config').findMany(), b.publish.mock.calls]);
    expect(sinks).not.toContain('SYNTHETIC-SECRET');
    expect(b.publish.mock.calls[0][1]).toMatchObject({ newValue: '[REDACTED]', sensitive: true, ownerId: 'u1' });
    const plain = new LayeredConfigService(db, scopes());
    await expect(plain.set('app', 'apiKey', 'x', 'system')).rejects.toThrow('encryption adapter');
  });

  it('M18: a change published by another replica evicts the local entry', async () => {
    const db = new InMemoryAdapter();
    const b = bus();
    const service = new LayeredConfigService(db, scopes(), undefined, b);
    await service.set('app', 'theme', 'v1', 'tenant', 't1');
    expect(await service.get('app', 'theme', { tenantId: 't1' })).toBe('v1');
    await db.model('config').update({ where: { scope_key: { scope: 'app@tenant:t1', key: 'theme' } }, data: { value: 'v2' } });
    const remote: LayeredConfigChangePayload = { scope: 'app', key: 'theme', layer: 'tenant', ownerId: 't1', oldValue: 'v1', newValue: 'v2' };
    await b.publish(LAYERED_CONFIG_CHANGED_TOPIC, remote);
    expect(await service.get('app', 'theme', { tenantId: 't1' })).toBe('v2');
  });

  it('M18: cached values expire after the configured TTL', async () => {
    vi.useFakeTimers();
    const db = new InMemoryAdapter();
    const service = new LayeredConfigService(db, scopes(), undefined, undefined, undefined, { ttlMs: 1000 });
    await service.set('app', 'theme', 'v1', 'system');
    await db.model('config').update({ where: { scope_key: { scope: 'app@system', key: 'theme' } }, data: { value: 'v2' } });
    expect(await service.get('app', 'theme')).toBe('v1');
    vi.advanceTimersByTime(1001);
    expect(await service.get('app', 'theme')).toBe('v2');
  });
});

describe('ConfigService', () => {
  it('M18: evicts on a remote change event', async () => {
    const db = new InMemoryAdapter();
    const b = bus();
    const service = new ConfigService(db, undefined, undefined, undefined, b);
    await service.set('app', 'theme', 'v1');
    await db.model('config').update({ where: { scope_key: { scope: 'app', key: 'theme' } }, data: { value: 'v2' } });
    await b.publish(CONFIG_CHANGED_TOPIC, { scope: 'app', key: 'theme', oldValue: 'v1', newValue: 'v2' });
    expect(await service.get('app', 'theme')).toBe('v2');
  });

  it('L5: scope/key containing ":" no longer collide', async () => {
    const service = new ConfigService(new InMemoryAdapter());
    await service.set('a:b', 'c', 'first');
    await service.set('a', 'b:c', 'second');
    expect(await service.get('a:b', 'c')).toBe('first');
    expect(await service.get('a', 'b:c')).toBe('second');
  });

  it('L5: an update failure other than "not found" is not turned into a create', async () => {
    const create = vi.fn();
    const db = { model: () => ({
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => { throw Object.assign(new Error('connection lost'), { code: 'P1001' }); }),
      create,
    }) } as unknown as DatabaseAdapter;
    await expect(new ConfigService(db).set('app', 'theme', 'x')).rejects.toThrow('connection lost');
    expect(create).not.toHaveBeenCalled();
  });

  it('L5: rollback removes a key that did not exist and reports a missing history row', async () => {
    const db = new InMemoryAdapter();
    const service = new ConfigService(db);
    await service.set('app', 'theme', 'dark');
    const [row] = await db.model('configHistory').findMany() as Array<{ id: string }>;
    await service.rollback(row.id);
    service.clearCache();
    expect(await service.get('app', 'theme')).toBeUndefined();
    await expect(service.rollback('missing')).rejects.toThrow('not found');
  });
});

describe('L7: ConfigFileWatcher', () => {
  it('keeps observing a file after an atomic rename-replace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zucker-config-watch-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, '{"v":1}');
    const watcher = new ConfigFileWatcher({ stabilityMs: 20, deleteGraceMs: 20 });
    const callback = vi.fn();
    watcher.watch(file, callback);
    try {
      const replace = async (v: number) => {
        const tmp = join(dir, `tmp-${v}.json`);
        writeFileSync(tmp, `{"v":${v}}`);
        await new Promise((r) => setTimeout(r, 15));
        renameSync(tmp, file);
        await vi.waitFor(() => expect(callback.mock.calls.length).toBeGreaterThanOrEqual(v - 1), { timeout: 2000 });
      };
      await replace(2);
      await replace(3);
    } finally {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
