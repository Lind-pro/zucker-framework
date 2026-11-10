import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SecretCipher } from '@zucker-framework/core';
import { ConfigService, ConfigScopeManager, type ConfigChangePayload, type ConfigEncryptor } from '@zucker-framework/config';
import { ApplicationDatabase } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_config_${randomUUID().replaceAll('-', '')}`;

run('protected configuration using real PostgreSQL', () => {
  let pool: Pool, database: ApplicationDatabase, scopedUrl: string;
  const scopes = new ConfigScopeManager();
  scopes.register({ id: 'synthetic-connections', name: 'Synthetic connections', isPublic: false, publicAccess: false,
    properties: ['apiKey', 'secondKey'].map(key => ({ key, name: key, type: 'string', description: 'Synthetic credential',
      defaultValue: undefined, readonly: false, encrypted: true })) });
  const encryptor: ConfigEncryptor = new SecretCipher({ masterKey: randomBytes(32).toString('hex') });
  function settings(db = database) {
    const events = new EventEmitter2(), changes: ConfigChangePayload[] = [];
    const service = new ConfigService(db, events, scopes, encryptor);
    service.onChange(value => changes.push(value)); return { service, changes };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.pathname !== '/cnipa_dev' && !/(?:_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href; database = new ApplicationDatabase(scopedUrl);
  });
  afterAll(async () => {
    try { await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('survives application reconstruction with only ciphertext in configuration and no secrets in history/events', async () => {
    const f = settings();
    await f.service.set('synthetic-connections', 'apiKey', 'SYNTHETIC-PRIVATE-ORIGINAL');
    await f.service.set('synthetic-connections', 'apiKey', 'SYNTHETIC-PRIVATE-CURRENT');
    const stored = await pool.query(`SELECT * FROM "${schema}".config`), history = await pool.query(`SELECT * FROM "${schema}".config_history`);
    expect(history.rows).toHaveLength(2);
    expect(JSON.stringify([stored.rows, history.rows, f.changes])).not.toContain('SYNTHETIC-PRIVATE-');
    const restarted = new ApplicationDatabase(scopedUrl);
    try { expect(await settings(restarted).service.get('synthetic-connections', 'apiKey')).toBe('SYNTHETIC-PRIVATE-CURRENT'); }
    finally { await restarted.disconnect(); }
  });

  it('keeps storage, cache and events at the old value after a later batch write fails', async () => {
    const f = settings(); expect(await f.service.get('synthetic-connections', 'apiKey')).toBe('SYNTHETIC-PRIVATE-CURRENT');
    await pool.query(`CREATE FUNCTION "${schema}".reject_second_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic configuration failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_second_config BEFORE INSERT OR UPDATE ON "${schema}".config FOR EACH ROW WHEN (NEW.key='secondKey') EXECUTE FUNCTION "${schema}".reject_second_config()`);
    try { await expect(f.service.setProperties('synthetic-connections', { apiKey: 'SYNTHETIC-PRIVATE-UNCOMMITTED', secondKey: 'SYNTHETIC-PRIVATE-SECOND' })).rejects.toThrow(); }
    finally { await pool.query(`DROP TRIGGER reject_second_config ON "${schema}".config`); await pool.query(`DROP FUNCTION "${schema}".reject_second_config()`); }
    expect(await f.service.get('synthetic-connections', 'apiKey')).toBe('SYNTHETIC-PRIVATE-CURRENT');
    f.service.clearCache(); expect(await f.service.get('synthetic-connections', 'apiKey')).toBe('SYNTHETIC-PRIVATE-CURRENT');
    expect(await f.service.get('synthetic-connections', 'secondKey')).toBeUndefined(); expect(f.changes).toEqual([]);
  });

  it('does not expose legacy secret history or restore it as a credential', async () => {
    const f = settings();
    const record = await database.model('configHistory').create({ data: { scope: 'synthetic-connections', key: 'apiKey',
      oldValue: JSON.stringify('SYNTHETIC-LEGACY-PRIVATE'), newValue: JSON.stringify('SYNTHETIC-LEGACY-NEW'), changedAt: new Date() } }) as { id: string };
    expect(JSON.stringify(await f.service.getHistory('synthetic-connections'))).not.toContain('SYNTHETIC-');
    await expect(f.service.rollback(record.id)).rejects.toThrow('explicit replacement');
    expect(await f.service.get('synthetic-connections', 'apiKey')).toBe('SYNTHETIC-PRIVATE-CURRENT');
  });
});
