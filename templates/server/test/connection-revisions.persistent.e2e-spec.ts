import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConnectionProfileStore, parseConnectionUpdate } from '@zucker-framework/config/connections';
import { SecretCipher } from '@zucker-framework/core';
import { ApplicationDatabase } from '../src/database';
import { CONNECTION_PROFILE_DEFINITIONS } from '../src/runtime-settings/connection-settings.descriptors';
import { ConnectionSettingsService, CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_connection_revisions_${randomUUID().replaceAll('-', '')}`;
const key = 'synthetic-config-encryption-key-which-is-never-a-jwt';
const SECRET_1 = 'SYNTHETIC-REVISION-SECRET-ONE', SECRET_2 = 'SYNTHETIC-REVISION-SECRET-TWO';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: 'http://localhost:4202', CONFIG_ENCRYPTION_KEY: key, JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters',
  BILLING_CREEM_ENABLED: 'false', CREEM_WEBHOOK_SECRET: 'SYNTHETIC-REVISION-ENV-WEBHOOK', FILES_STORAGE_PROVIDER: 'local' };
const creem = (secret: string, expectedRevision: number, scope = 'synthetic-account') => ({ expectedRevision,
  values: { BILLING_CREEM_ENABLED: 'true', BILLING_CREEM_MODE: 'test', BILLING_CREEM_ACCOUNT_SCOPE: scope }, secrets: { CREEM_API_KEY: { action: 'replace', value: secret } } });

run('connection profile revision archive (PostgreSQL)', () => {
  let pool: Pool, database: ApplicationDatabase;
  const actor = 'synthetic-operator';
  const archived = async (profileId = 'payment-creem') =>
    (await pool.query(`SELECT "revision", "ciphertext", "createdBy" FROM "${schema}"."connection_profile_revisions" WHERE "profileId" = $1 ORDER BY "revision"`, [profileId])).rows as Array<{ revision: number; ciphertext: string; createdBy: string | null }>;
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
  });
  afterAll(async () => { await database?.disconnect(); await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool?.end(); });

  it('archives every saved revision encrypted, reports only counts and resolves an older revision internally', async () => {
    const settings = new ConnectionSettingsService(database, env);
    await settings.save(actor, 'payment-creem', creem(SECRET_1, 0));
    const second = await settings.save(actor, 'payment-creem', creem(SECRET_2, 1, 'synthetic-account-two'));
    expect(second).toMatchObject({ storedRevision: 2, retainedRevisions: 2 });
    const rows = await archived();
    expect(rows.map(row => [row.revision, row.createdBy])).toEqual([[1, actor], [2, actor]]);
    for (const row of rows) { expect(row.ciphertext).toMatch(/^v2\./); expect(row.ciphertext).not.toContain('SYNTHETIC'); }
    expect((await settings.environmentAt('payment-creem', 1))?.CREEM_API_KEY).toBe(SECRET_1);
    expect((await settings.environmentAt('payment-creem', 1))?.BILLING_CREEM_ACCOUNT_SCOPE).toBe('synthetic-account');
    expect((await settings.environmentAt('payment-creem', 2))?.CREEM_API_KEY).toBe(SECRET_2);
    expect(await settings.environmentAt('payment-creem', 3)).toBeUndefined();
    expect(await settings.currentRevision('payment-creem')).toBe(2);
    expect((await settings.revisions('payment-creem')).map(row => row.revision)).toEqual([2, 1]);
    const list = await settings.list(), single = await settings.get('payment-creem');
    expect(list.profiles.find(row => row.id === 'payment-creem')?.retainedRevisions).toBe(2);
    expect(list.profiles.find(row => row.id === 'payment-stripe')?.retainedRevisions).toBe(0);
    for (const body of [JSON.stringify(list), JSON.stringify(single), JSON.stringify(second)]) {
      expect(body).not.toContain('SYNTHETIC-REVISION'); expect(body).not.toContain(rows[0].ciphertext.slice(0, 24));
    }
    // An unchanged save writes nothing.
    await settings.save(actor, 'payment-creem', creem(SECRET_2, 2, 'synthetic-account-two'));
    expect(await archived()).toHaveLength(2);
  });

  it('rolls back live value, archive row and audit together', async () => {
    const definition = CONNECTION_PROFILE_DEFINITIONS.find(row => row.profile.id === 'payment-creem')!;
    const store = new ConnectionProfileStore({ scope: CONNECTION_SETTINGS_SCOPE, definitions: CONNECTION_PROFILE_DEFINITIONS, cipher: new SecretCipher({ masterKey: key }),
      audit: async () => { throw new Error('synthetic audit failure'); } });
    const update = parseConnectionUpdate(definition.profile, creem(SECRET_1, 0));
    await expect(database.transaction(tx => store.save(tx, definition, update, actor))).rejects.toThrow('synthetic audit failure');
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE])).rows[0].n).toBe(0);
    expect(await archived()).toHaveLength(0);
  });

  it('backfills the current revision of databases saved before the archive, once under concurrent starts', async () => {
    const settings = new ConnectionSettingsService(database, env);
    await settings.save(actor, 'payment-creem', creem(SECRET_1, 0)); await settings.save(actor, 'payment-creem', creem(SECRET_2, 1));
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
    const starts = [new ConnectionSettingsService(database, env), new ConnectionSettingsService(database, env)];
    await Promise.all(starts.map(service => service.environment()));
    const rows = await archived();
    expect(rows.map(row => [row.revision, row.createdBy])).toEqual([[2, null]]);
    expect((await starts[0].environmentAt('payment-creem', 2))?.CREEM_API_KEY).toBe(SECRET_2);
  });

  it('keeps archived revisions when the live value was deleted out of band and continues numbering above them', async () => {
    const settings = new ConnectionSettingsService(database, env);
    await settings.save(actor, 'payment-creem', creem(SECRET_1, 0)); await settings.save(actor, 'payment-creem', creem(SECRET_2, 1));
    await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
    expect(await settings.currentRevision('payment-creem')).toBe(0);
    const saved = await settings.save(actor, 'payment-creem', creem(SECRET_1, 0, 'synthetic-account-three'));
    expect(saved).toMatchObject({ storedRevision: 3, retainedRevisions: 3 });
    expect((await settings.environmentAt('payment-creem', 3))?.BILLING_CREEM_ACCOUNT_SCOPE).toBe('synthetic-account-three');
    expect((await settings.environmentAt('payment-creem', 2))?.CREEM_API_KEY).toBe(SECRET_2);
    expect(await settings.currentRevision('payment-creem')).toBe(3);
  });

  it('re-saves a live value restored below the highest archived revision under a new number at start-up', async () => {
    const settings = new ConnectionSettingsService(database, env);
    await settings.save(actor, 'payment-creem', creem(SECRET_1, 0));
    const first = (await pool.query(`SELECT "value" FROM "${schema}"."config" WHERE "scope" = $1 AND "key" = 'payment-creem'`, [CONNECTION_SETTINGS_SCOPE])).rows[0].value;
    await settings.save(actor, 'payment-creem', creem(SECRET_2, 1, 'synthetic-account-two'));
    // Restore the revision-1 live row (for example from an older backup of the config table only).
    await pool.query(`UPDATE "${schema}"."config" SET "value" = $1::jsonb WHERE "scope" = $2 AND "key" = 'payment-creem'`, [JSON.stringify(first), CONNECTION_SETTINGS_SCOPE]);
    const restarted = new ConnectionSettingsService(database, env);
    await restarted.environment();
    expect(restarted.appliedRevision('payment-creem')).toBe('payment-creem@3');
    expect(await restarted.currentRevision('payment-creem')).toBe(3);
    expect((await archived()).map(row => [row.revision, row.createdBy])).toEqual([[1, actor], [2, actor], [3, null]]);
    expect((await restarted.environmentAt('payment-creem', 3))?.CREEM_API_KEY).toBe(SECRET_1);
    expect((await restarted.environmentAt('payment-creem', 2))?.CREEM_API_KEY).toBe(SECRET_2);
  });

  it('fails closed (503) when an archived revision cannot be decrypted', async () => {
    await new ConnectionSettingsService(database, env).save(actor, 'payment-creem', creem(SECRET_1, 0));
    await new ConnectionSettingsService(database, env).save(actor, 'payment-creem', creem(SECRET_2, 1));
    // Replace revision 1 with a row encrypted under another key; the live value (revision 2) stays readable.
    const foreign = new SecretCipher({ masterKey: 'another-synthetic-key-of-at-least-32-chars' }).encrypt(JSON.stringify({ revision: 1, values: {} }));
    await pool.query(`UPDATE "${schema}"."connection_profile_revisions" SET "ciphertext" = $1 WHERE "profileId" = 'payment-creem' AND "revision" = 1`, [foreign]);
    const settings = new ConnectionSettingsService(database, env);
    await expect(settings.environmentAt('payment-creem', 1)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(settings.environmentAt('payment-creem', 1)).rejects.toThrow('Saved connection configuration cannot be read');
    expect((await settings.environmentAt('payment-creem', 2))?.CREEM_API_KEY).toBe(SECRET_2);
  });

  it('serves the current revision through strict and ttl slots without restart', async () => {
    const settings = new ConnectionSettingsService(database, env, { hotProfileCacheTtlMs: 60_000 });
    await settings.save(actor, 'payment-creem', creem(SECRET_1, 0));
    const other = new ConnectionSettingsService(database, env, { hotProfileCacheTtlMs: 60_000 });
    const build = (environment: Readonly<NodeJS.ProcessEnv>, revisions: ReadonlyMap<string, number>) => ({ key: environment.CREEM_API_KEY, revision: revisions.get('payment-creem') });
    const strict = other.createSlot({ profiles: ['payment-creem'], freshness: 'strict', build });
    const ttl = other.createSlot({ profiles: ['payment-creem'], freshness: 'ttl', build });
    expect(await strict.get()).toEqual({ key: SECRET_1, revision: 1 });
    expect(await ttl.get()).toEqual({ key: SECRET_1, revision: 1 });
    await settings.save(actor, 'payment-creem', creem(SECRET_2, 1));
    // Another process: strict sees the commit at once; ttl keeps its cached revision until expiry.
    expect(await strict.get()).toEqual({ key: SECRET_2, revision: 2 });
    expect(await ttl.get()).toEqual({ key: SECRET_1, revision: 1 });
    // A restart profile's start-up snapshot is unchanged (no behaviour change for restart consumers).
    expect((await other.environment()).CREEM_API_KEY).toBe(SECRET_1);
    expect(other.appliedRevision('payment-')).toBe('payment-creem@1,payment-paypal@0,payment-stripe@0');
  });
});
