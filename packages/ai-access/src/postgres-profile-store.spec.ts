// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { CredentialProfile } from './contracts';
import {
  PostgresCredentialProfileStore,
  type PostgresPoolClient,
  type PostgresPoolLike,
  type PostgresQueryResult,
} from './postgres-profile-store';

/**
 * Fake pool with a hard connection limit and a shared advisory-lock table. Each query
 * records which connection it ran on; checking out beyond the limit waits forever, like
 * pg's default pool, so a deadlock shows up as a test timeout.
 */
function fakePool(size: number) {
  const rows = new Map<string, Record<string, unknown>>();
  const locks = new Map<string, number>();
  const waiters: Array<(client: PostgresPoolClient) => void> = [];
  const log: Array<{ connection: number | 'pool'; sql: string }> = [];
  let inUse = 0;
  let nextId = 1;

  const run = async (connection: number | 'pool', sql: string, values: unknown[] = []) => {
    log.push({ connection, sql });
    await Promise.resolve();
    if (sql.includes('pg_try_advisory_lock')) {
      const key = String(values[0]);
      const owner = locks.get(key);
      if (owner !== undefined && owner !== connection) return { rows: [{ locked: false }] };
      locks.set(key, connection as number);
      return { rows: [{ locked: true }] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      locks.delete(String(values[0]));
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    if (sql.trim().startsWith('SELECT *')) {
      const row = rows.get(`${values[0]}/${values[1]}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('INSERT INTO')) {
      rows.set(`${values[1]}/${values[2]}`, {
        id: values[0],
        provider_id: values[1],
        profile_name: values[2],
        auth_method: values[3],
        ownership: values[4],
        credential: values[5],
        metadata: values[6],
        expires_at: values[7],
        created_at: values[8],
        updated_at: values[9],
      });
      return { rows: [] };
    }
    return { rows: [] };
  };

  const makeClient = (): PostgresPoolClient => {
    const id = nextId++;
    return {
      query: (<Row>(sql: string, values?: unknown[]) =>
        run(id, sql, values) as Promise<PostgresQueryResult<Row>>) as PostgresPoolClient['query'],
      release: () => {
        const waiter = waiters.shift();
        if (waiter) waiter(makeClient());
        else inUse -= 1;
      },
    };
  };

  const pool: PostgresPoolLike = {
    // A bare pool.query also needs a connection; model it as checkout + release.
    query: (async (sql: string, values?: unknown[]) => {
      const client = await pool.connect();
      try {
        return await run('pool', sql, values);
      } finally {
        client.release();
      }
    }) as PostgresPoolLike['query'],
    connect: () => {
      if (inUse < size) {
        inUse += 1;
        return Promise.resolve(makeClient());
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
  return { pool, rows, log };
}

const profile = (token: string): CredentialProfile => ({
  id: 'openai-codex:default',
  providerId: 'openai-codex',
  profileName: 'default',
  authMethod: 'device-code',
  ownership: 'managed',
  credential: { kind: 'oauth', accessToken: token, refreshToken: `r-${token}`, expiresAt: 1 },
  metadata: { createdAt: 1, updatedAt: 1 },
});

describe('PostgresCredentialProfileStore.runExclusive', () => {
  it('runs the operation on the locked connection and never deadlocks a small pool', async () => {
    const { pool, log } = fakePool(2);
    const store = new PostgresCredentialProfileStore({ pool });
    await store.save(profile('t0'));

    // More concurrent callers than connections: before the fix every waiter held a
    // connection inside pg_advisory_lock while the holder waited for a free one.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.runExclusive('openai-codex:default', async () => {
          const current = await store.get('openai-codex');
          await store.save(profile(`t${index + 1}`));
          return current?.credential.kind;
        }),
      ),
    );

    expect(results).toEqual(Array(6).fill('oauth'));
    const insideLock = log.filter(
      (entry) => entry.sql.trim().startsWith('SELECT *') || entry.sql.includes('INSERT INTO'),
    );
    // Only the initial save (outside the lock) used a separate pool query.
    expect(insideLock.filter((entry) => entry.connection === 'pool')).toHaveLength(1);
  });

  it('is re-entrant for the same profile and fails after the lock timeout', async () => {
    const { pool } = fakePool(2);
    const store = new PostgresCredentialProfileStore({ pool, lockTimeoutMs: 30, lockRetryIntervalMs: 5 });
    await expect(
      store.runExclusive('p', () => store.runExclusive('p', async () => 'nested')),
    ).resolves.toBe('nested');

    // Another process holds the lock: simulate with a second store on the same pool.
    const other = new PostgresCredentialProfileStore({ pool, lockTimeoutMs: 30, lockRetryIntervalMs: 5 });
    let release = () => {};
    const held = other.runExclusive('q', () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(store.runExclusive('q', async () => 'never')).rejects.toThrow('锁等待超时');
    release();
    await held;
  });
});

describe('PostgresCredentialProfileStore credentialCodec', () => {
  it('stores credentials encrypted and still reads legacy plaintext rows', async () => {
    const { pool, rows } = fakePool(2);
    const legacy = new PostgresCredentialProfileStore({ pool });
    await legacy.save(profile('plain'));

    const codec = {
      encrypt: (value: string) => Buffer.from(value).toString('base64'),
      decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
    };
    const store = new PostgresCredentialProfileStore({ pool, credentialCodec: codec });
    await expect(store.get('openai-codex')).resolves.toMatchObject({
      credential: { accessToken: 'plain' },
    });

    await store.save(profile('secret-token'));
    const stored = String(rows.get('openai-codex/default')?.credential);
    expect(stored).not.toContain('secret-token');
    expect(JSON.parse(stored)).toHaveProperty('$encrypted');
    await expect(store.get('openai-codex')).resolves.toMatchObject({
      credential: { accessToken: 'secret-token' },
    });
    await expect(legacy.get('openai-codex')).rejects.toThrow('credentialCodec');
  });
});
