import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter2 } from 'eventemitter2';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { SecretCipher, type DatabaseAdapter } from '@zucker-framework/core';
import { ConfigService, type ConfigEncryptor, type ConfigChangePayload } from './config.service';
import { ConfigScopeManager } from './config-scope-manager';

function fixture() {
  const db = new InMemoryAdapter(), events = new EventEmitter2(), scopes = new ConfigScopeManager();
  scopes.register({ id: 'connections', name: 'Connections', isPublic: false, publicAccess: false,
    properties: ['apiKey', 'secondKey'].map(key => ({ key, name: key, type: 'string', defaultValue: undefined,
      description: 'Synthetic protected setting', readonly: false, encrypted: true })) });
  const encryptor: ConfigEncryptor = new SecretCipher({ masterKey: randomBytes(32).toString('hex') });
  const bus = { publish: vi.fn(async () => {}) };
  const service = new ConfigService(db, events, scopes, encryptor, bus);
  const changes: ConfigChangePayload[] = []; service.onChange(change => changes.push(change));
  return { db, events, scopes, encryptor, service, bus, changes };
}

describe('protected configuration boundaries', () => {
  it('encrypts stored values and keeps secrets out of history and both change-event channels', async () => {
    const f = fixture(); const first = 'SYNTHETIC-PRIVATE-FIRST', second = 'SYNTHETIC-PRIVATE-SECOND';
    await f.service.set('connections', 'apiKey', first);
    f.service.clearCache(); await f.service.set('connections', 'apiKey', second);
    expect(await f.service.get('connections', 'apiKey')).toBe(second);
    f.service.clearCache(); expect(await f.service.getAll('connections')).toEqual({ apiKey: second });
    await f.service.remove('connections', 'apiKey');
    const sinks = JSON.stringify([await f.db.model('config').findMany(), await f.db.model('configHistory').findMany(), f.changes, f.bus.publish.mock.calls]);
    expect(sinks).not.toContain(first); expect(sinks).not.toContain(second);
    expect(f.changes).toEqual([
      { scope: 'connections', key: 'apiKey', oldValue: undefined, newValue: '[REDACTED]', sensitive: true },
      { scope: 'connections', key: 'apiKey', oldValue: '[REDACTED]', newValue: '[REDACTED]', sensitive: true },
      { scope: 'connections', key: 'apiKey', oldValue: '[REDACTED]', newValue: undefined, sensitive: true },
    ]);
  });

  it('fails before persistence without an encryptor or with a non-string protected value', async () => {
    const f = fixture(), missing = new ConfigService(f.db, f.events, f.scopes);
    await expect(missing.set('connections', 'apiKey', 'SYNTHETIC-SECRET')).rejects.toThrow('encryption adapter');
    await expect(missing.setProperties('connections', { apiKey: 'SYNTHETIC-SECRET' })).rejects.toThrow('encryption adapter');
    await expect(f.service.set('connections', 'apiKey', { value: 'SYNTHETIC-SECRET' })).rejects.toThrow('must be a string');
    expect(await f.db.model('config').count({})).toBe(0);
  });

  it('does not silently replace corrupt ciphertext with defaults or leak decryptor errors', async () => {
    const f = fixture(); await f.service.set('connections', 'apiKey', 'synthetic');
    const broken = new ConfigService(f.db, f.events, f.scopes, { encrypt: f.encryptor.encrypt,
      decrypt() { throw new Error('SYNTHETIC-PRIVATE-DECRYPTOR-DETAIL'); } });
    await expect(broken.getOrDefault('connections', 'apiKey', 'fallback')).rejects.toThrow('Protected configuration could not be decrypted');
    await expect(broken.getAll('connections')).rejects.toThrow('Protected configuration could not be decrypted');
    const missing = new ConfigService(f.db, f.events, f.scopes);
    await expect(missing.get('connections', 'apiKey')).rejects.toThrow('encryption adapter');
    await expect(missing.getAll('connections')).rejects.toThrow('encryption adapter');
  });

  it('redacts legacy history reads and refuses to turn a redacted or historical secret into a new credential', async () => {
    const f = fixture();
    const row = await f.db.model('configHistory').create({ data: { scope: 'connections', key: 'apiKey',
      oldValue: JSON.stringify('SYNTHETIC-LEGACY-SECRET'), newValue: JSON.stringify('SYNTHETIC-NEW-SECRET'), changedAt: new Date() } }) as { id: string };
    expect(JSON.stringify(await f.service.getHistory('connections'))).not.toContain('SYNTHETIC-');
    await expect(f.service.rollback(row.id)).rejects.toThrow('explicit replacement');
    expect(await f.db.model('config').count({})).toBe(0);
  });

  it('emits only redacted batch values after persistence succeeds', async () => {
    const f = fixture(); await f.service.setProperties('connections', { apiKey: 'SYNTHETIC-BATCH-ONE', secondKey: 'SYNTHETIC-BATCH-TWO' });
    const sinks = JSON.stringify([await f.db.model('config').findMany(), f.changes, f.bus.publish.mock.calls]);
    expect(sinks).not.toContain('SYNTHETIC-BATCH-');
    expect(f.changes).toHaveLength(2); expect(f.changes.every(value => value.sensitive && value.newValue === '[REDACTED]')).toBe(true);
    f.service.clearCache(); expect(await f.service.get('connections', 'secondKey')).toBe('SYNTHETIC-BATCH-TWO');
  });

  it('does not publish a failed transaction into the process cache or event channels', async () => {
    const f = fixture(); const txModel = { update: vi.fn(async () => ({})), create: vi.fn(async () => ({})) };
    const adapter: DatabaseAdapter = { model: name => f.db.model(name), async $transaction(work) {
      await work({ model: () => txModel as unknown as ReturnType<DatabaseAdapter['model']>, $transaction: async () => { throw new Error('Unexpected nesting'); } });
      throw new Error('Synthetic commit failure');
    } };
    const service = new ConfigService(adapter, f.events, f.scopes, f.encryptor, f.bus);
    await service.set('connections', 'apiKey', 'SYNTHETIC-OLD');
    f.changes.length = 0; f.bus.publish.mockClear();
    await expect(service.setProperties('connections', { apiKey: 'SYNTHETIC-UNCOMMITTED' })).rejects.toThrow('commit failure');
    expect(await service.get('connections', 'apiKey')).toBe('SYNTHETIC-OLD');
    expect(f.changes).toEqual([]); expect(f.bus.publish).not.toHaveBeenCalled();
  });
});
