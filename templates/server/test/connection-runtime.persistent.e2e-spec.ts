import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ConnectionProfileStore, ConnectionRuntime } from '@zucker-framework/config/connections';
import { SecretCipher } from '@zucker-framework/core';
import { ApplicationDatabase } from '../src/database';
import { CONNECTION_PROFILE_DEFINITIONS } from '../src/runtime-settings/connection-settings.descriptors';
import { ConnectionSettingsService, CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';

// WP 4.1a (Sonnet): ttl slot convergence driven by an injected clock, and concurrent starts against a
// legacy database (saved profiles without archive rows) with several profiles.
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_conn_runtime_${randomUUID().replaceAll('-', '')}`;
const key = 'synthetic-config-encryption-key-which-is-never-a-jwt';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: 'http://localhost:4202', CONFIG_ENCRYPTION_KEY: key, JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters',
  BILLING_CREEM_ENABLED: 'false', CREEM_WEBHOOK_SECRET: 'SYNTHETIC-RUNTIME-ENV-WEBHOOK', FILES_STORAGE_PROVIDER: 'local' };
const creem = (secret: string, expectedRevision: number) => ({ expectedRevision,
  values: { BILLING_CREEM_ENABLED: 'true', BILLING_CREEM_MODE: 'test', BILLING_CREEM_ACCOUNT_SCOPE: 'synthetic-account' }, secrets: { CREEM_API_KEY: { action: 'replace', value: secret } } });

run('connection runtime clock and concurrent start-up (PostgreSQL)', () => {
  let pool: Pool, database: ApplicationDatabase;
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

  it('a ttl slot on another process converges only after the TTL, a strict slot at once; a local save invalidates immediately', async () => {
    const writer = new ConnectionSettingsService(database, env);
    await writer.save('synthetic-operator', 'payment-creem', creem('SYNTHETIC-TTL-1', 0));
    let clock = 1_000_000;
    const store = new ConnectionProfileStore({ scope: CONNECTION_SETTINGS_SCOPE, definitions: CONNECTION_PROFILE_DEFINITIONS, cipher: new SecretCipher({ masterKey: key }) });
    const runtime = new ConnectionRuntime({ database, store, environment: env, cacheTtlMs: 30_000, now: () => clock });
    const build = (environment: Readonly<NodeJS.ProcessEnv>, revisions: ReadonlyMap<string, number>) => ({ key: environment.CREEM_API_KEY, revision: revisions.get('payment-creem') });
    const ttl = runtime.createSlot({ profiles: ['payment-creem'], freshness: 'ttl', build }), strict = runtime.createSlot({ profiles: ['payment-creem'], freshness: 'strict', build });
    expect(await ttl.get()).toEqual({ key: 'SYNTHETIC-TTL-1', revision: 1 });
    await writer.save('synthetic-operator', 'payment-creem', creem('SYNTHETIC-TTL-2', 1));   // other process
    clock += 29_999;
    expect(await ttl.get()).toEqual({ key: 'SYNTHETIC-TTL-1', revision: 1 });                 // still within the TTL
    expect(await strict.get()).toEqual({ key: 'SYNTHETIC-TTL-2', revision: 2 });
    clock += 2;
    expect(await ttl.get()).toEqual({ key: 'SYNTHETIC-TTL-2', revision: 2 });                 // converged after expiry
    // A save through this runtime invalidates its own cache without waiting for the TTL.
    await runtime.save('synthetic-operator', 'payment-creem', { expectedRevision: 2, values: {}, secrets: { CREEM_API_KEY: { action: 'replace', value: 'SYNTHETIC-TTL-3' } } });
    expect(await ttl.get()).toEqual({ key: 'SYNTHETIC-TTL-3', revision: 3 });
    await ttl.close(); await strict.close();
  });

  it('two concurrent starts against a legacy database archive each saved profile exactly once', async () => {
    const seed = new ConnectionSettingsService(database, env);
    await seed.save('synthetic-operator', 'payment-creem', creem('SYNTHETIC-LEGACY-C1', 0));
    await seed.save('synthetic-operator', 'payment-creem', { expectedRevision: 1, values: {}, secrets: { CREEM_API_KEY: { action: 'replace', value: 'SYNTHETIC-LEGACY-C2' } } });
    await seed.save('synthetic-operator', 'identity-google', { expectedRevision: 0, values: { GOOGLE_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: 'synthetic-legacy-google' }, secrets: { GOOGLE_CLIENT_SECRET: { action: 'replace', value: 'SYNTHETIC-LEGACY-GOOGLE-SECRET' } } });
    await seed.save('synthetic-operator', 'account-email', { expectedRevision: 0, values: { SMTP_HOST: 'smtp.example.invalid', SMTP_FROM: 'account@example.invalid' } });
    // Simulate a database saved before the archive existed.
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
    const starts = Array.from({ length: 4 }, () => new ConnectionSettingsService(database, env));
    const snapshots = await Promise.all(starts.map(service => service.environment()));
    const rows = (await pool.query(`SELECT "profileId", "revision", "createdBy" FROM "${schema}"."connection_profile_revisions" ORDER BY "profileId", "revision"`)).rows;
    expect(rows).toEqual([
      { profileId: 'account-email', revision: 1, createdBy: null },
      { profileId: 'identity-google', revision: 1, createdBy: null },
      { profileId: 'payment-creem', revision: 2, createdBy: null },
    ]);
    for (const snapshot of snapshots) { expect(snapshot.CREEM_API_KEY).toBe('SYNTHETIC-LEGACY-C2'); expect(snapshot.GOOGLE_CLIENT_ID).toBe('synthetic-legacy-google'); }
    expect((await starts[0].environmentAt('payment-creem', 2))?.CREEM_API_KEY).toBe('SYNTHETIC-LEGACY-C2');
    expect(await starts[1].currentRevision('payment-creem')).toBe(2);
    // A later start changes nothing.
    await new ConnectionSettingsService(database, env).environment();
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."connection_profile_revisions"`)).rows[0].n).toBe(3);
  });
});
