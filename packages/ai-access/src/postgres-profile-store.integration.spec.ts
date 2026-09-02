// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { CredentialProfile } from './contracts';
import { PostgresCredentialProfileStore } from './postgres-profile-store';

const databaseUrl = process.env.AI_ACCESS_POSTGRES_TEST_URL;
const tableName = 'ai_credential_profiles_integration_test';
const suite = databaseUrl ? describe : describe.skip;
let pool: Pool;
let store: PostgresCredentialProfileStore;

suite('PostgresCredentialProfileStore integration', () => {
  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresCredentialProfileStore({ pool, tableName });
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
    await pool.end();
  });

  it('在 PostgreSQL 中完成 Profile 全生命周期', async () => {
    const now = Date.now();
    const profile: CredentialProfile = {
      id: 'openai-codex:default',
      providerId: 'openai-codex',
      profileName: 'default',
      authMethod: 'device-code',
      ownership: 'managed',
      credential: {
        kind: 'oauth',
        accessToken: 'access-test',
        refreshToken: 'refresh-test',
        expiresAt: now + 60_000,
      },
      expiresAt: now + 60_000,
      metadata: { accountId: 'acct-test', createdAt: now, updatedAt: now },
    };

    await store.save(profile);
    await expect(store.get('openai-codex')).resolves.toMatchObject({
      providerId: 'openai-codex',
      credential: { kind: 'oauth', accessToken: 'access-test' },
    });
    await expect(store.list()).resolves.toHaveLength(1);
    await expect(store.remove('openai-codex')).resolves.toBe(true);
    await expect(store.get('openai-codex')).resolves.toBeNull();
  });

  it('同一 Profile 的 PostgreSQL advisory lock 会串行化', async () => {
    const events: string[] = [];
    let releaseFirst = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = store.runExclusive('openai-codex:default', async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = store.runExclusive('openai-codex:default', async () => {
      events.push('second:start');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});
