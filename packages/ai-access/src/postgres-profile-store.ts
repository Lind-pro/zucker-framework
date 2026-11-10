import { AsyncLocalStorage } from 'node:async_hooks';
import {
  credentialProfileId,
  type CredentialMaterial,
  type CredentialProfile,
  type CredentialProfileStore,
} from './contracts';

export interface PostgresQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface PostgresQueryClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresPoolClient extends PostgresQueryClient {
  release(): void;
}

export interface PostgresPoolLike extends PostgresQueryClient {
  connect(): Promise<PostgresPoolClient>;
}

/**
 * Optional at-rest protection for the `credential` column. Both functions receive and
 * return opaque strings; the store keeps the result in a JSONB envelope
 * `{ "$encrypted": "<ciphertext>" }`. Rows written before a codec was configured remain
 * readable (plain JSON is detected and returned as-is) and are re-encrypted on next save.
 */
export interface CredentialCodec {
  encrypt(plaintext: string): string | Promise<string>;
  decrypt(ciphertext: string): string | Promise<string>;
}

export interface PostgresCredentialProfileStoreOptions {
  pool: PostgresPoolLike;
  tableName?: string;
  /** Encrypts OAuth/API credentials at rest. Strongly recommended in production. */
  credentialCodec?: CredentialCodec;
  /**
   * Maximum time `runExclusive` waits for the cross-process advisory lock before failing.
   * Defaults to 30 seconds. The lock is polled with `pg_try_advisory_lock`, so a waiter
   * never blocks inside PostgreSQL while holding a pooled connection indefinitely.
   */
  lockTimeoutMs?: number;
  /** Poll interval while waiting for the advisory lock. Defaults to 50 ms. */
  lockRetryIntervalMs?: number;
}

const ENCRYPTED_FIELD = '$encrypted';

interface ExclusiveScope {
  profileIds: Set<string>;
  client: PostgresQueryClient;
}

interface CredentialProfileRow {
  id: string;
  provider_id: string;
  profile_name: string;
  auth_method: string;
  ownership: 'managed' | 'external-readonly';
  credential: CredentialMaterial | string;
  metadata: CredentialProfile['metadata'] | string;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PostgresCredentialProfileStore implements CredentialProfileStore {
  private readonly pool: PostgresPoolLike;
  private readonly tableName: string;
  private readonly codec?: CredentialCodec;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryIntervalMs: number;
  /**
   * Queries issued inside `runExclusive` run on the connection that holds the advisory
   * lock. Using a second pooled connection there can exhaust the pool: every waiter would
   * hold a connection while the lock holder waits for a free one.
   */
  private readonly scope = new AsyncLocalStorage<ExclusiveScope>();
  /** In-process queue per profile so concurrent callers in one process share one lock wait. */
  private readonly localLocks = new Map<string, Promise<void>>();

  constructor(options: PostgresCredentialProfileStoreOptions) {
    this.pool = options.pool;
    this.codec = options.credentialCodec;
    this.lockTimeoutMs = positiveOr(options.lockTimeoutMs, 30_000);
    this.lockRetryIntervalMs = positiveOr(options.lockRetryIntervalMs, 50);
    this.tableName = options.tableName ?? 'ai_credential_profiles';
    if (!/^[a-z][a-z0-9_]*$/u.test(this.tableName)) {
      throw new Error('AI Credential Profile 表名格式无效。');
    }
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        profile_name TEXT NOT NULL DEFAULT 'default',
        auth_method TEXT NOT NULL,
        ownership TEXT NOT NULL CHECK (ownership IN ('managed', 'external-readonly')),
        credential JSONB NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (provider_id, profile_name)
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.tableName}_provider_idx ON ${this.tableName} (provider_id)`,
    );
  }

  async get(providerId: string, profileName = 'default'): Promise<CredentialProfile | null> {
    const result = await this.db().query<CredentialProfileRow>(
      `SELECT * FROM ${this.tableName} WHERE provider_id = $1 AND profile_name = $2 LIMIT 1`,
      [providerId, profileName],
    );
    return result.rows[0] ? await this.fromRow(result.rows[0]) : null;
  }

  async list(providerId?: string): Promise<CredentialProfile[]> {
    const result = providerId
      ? await this.db().query<CredentialProfileRow>(
          `SELECT * FROM ${this.tableName} WHERE provider_id = $1 ORDER BY provider_id, profile_name`,
          [providerId],
        )
      : await this.db().query<CredentialProfileRow>(
          `SELECT * FROM ${this.tableName} ORDER BY provider_id, profile_name`,
        );
    return Promise.all(result.rows.map((row) => this.fromRow(row)));
  }

  async save(profile: CredentialProfile): Promise<void> {
    const credential = await this.encodeCredential(profile.credential);
    await this.db().query(
      `
        INSERT INTO ${this.tableName} (
          id, provider_id, profile_name, auth_method, ownership,
          credential, metadata, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
        ON CONFLICT (provider_id, profile_name) DO UPDATE SET
          id = EXCLUDED.id,
          auth_method = EXCLUDED.auth_method,
          ownership = EXCLUDED.ownership,
          credential = EXCLUDED.credential,
          metadata = EXCLUDED.metadata,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        profile.id,
        profile.providerId,
        profile.profileName,
        profile.authMethod,
        profile.ownership,
        credential,
        JSON.stringify(profile.metadata),
        profile.expiresAt ? new Date(profile.expiresAt) : null,
        new Date(profile.metadata.createdAt),
        new Date(profile.metadata.updatedAt),
      ],
    );
  }

  async remove(providerId: string, profileName = 'default'): Promise<boolean> {
    const result = await this.db().query(
      `DELETE FROM ${this.tableName} WHERE provider_id = $1 AND profile_name = $2`,
      [providerId, profileName],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async runExclusive<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const active = this.scope.getStore();
    // Re-entrant: the current async context already holds this profile's lock.
    if (active?.profileIds.has(profileId)) return operation();

    const previous = this.localLocks.get(profileId) ?? Promise.resolve();
    let releaseLocal = () => {};
    const current = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const queued = previous.then(() => current);
    this.localLocks.set(profileId, queued);
    await previous;
    try {
      const client = active ? null : await this.pool.connect();
      const lockClient: PostgresQueryClient = client ?? active!.client;
      try {
        await this.acquireAdvisoryLock(lockClient, profileId);
        try {
          const profileIds = new Set(active?.profileIds ?? []);
          profileIds.add(profileId);
          return await this.scope.run({ profileIds, client: lockClient }, operation);
        } finally {
          await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [profileId]);
        }
      } finally {
        client?.release();
      }
    } finally {
      releaseLocal();
      if (this.localLocks.get(profileId) === queued) this.localLocks.delete(profileId);
    }
  }

  private async acquireAdvisoryLock(client: PostgresQueryClient, profileId: string): Promise<void> {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [profileId],
      );
      if (result.rows[0]?.locked === true) return;
      if (Date.now() >= deadline) {
        throw new Error(`AI Credential Profile 锁等待超时（${this.lockTimeoutMs}ms）。`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.lockRetryIntervalMs));
    }
  }

  private db(): PostgresQueryClient {
    return this.scope.getStore()?.client ?? this.pool;
  }

  private async encodeCredential(credential: CredentialMaterial): Promise<string> {
    const json = JSON.stringify(credential);
    if (!this.codec) return json;
    return JSON.stringify({ [ENCRYPTED_FIELD]: await this.codec.encrypt(json) });
  }

  private async decodeCredential(
    value: CredentialMaterial | Record<string, unknown> | string,
  ): Promise<CredentialMaterial> {
    const parsed = parseJsonField<CredentialMaterial | Record<string, unknown>>(value);
    const encrypted = (parsed as Record<string, unknown>)[ENCRYPTED_FIELD];
    if (typeof encrypted !== 'string') return parsed as CredentialMaterial;
    if (!this.codec) {
      throw new Error('AI Credential Profile 凭据已加密，但未配置 credentialCodec。');
    }
    return JSON.parse(await this.codec.decrypt(encrypted)) as CredentialMaterial;
  }

  private async fromRow(row: CredentialProfileRow): Promise<CredentialProfile> {
    const credential = await this.decodeCredential(row.credential);
    const metadata = parseJsonField<CredentialProfile['metadata']>(row.metadata);
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : undefined;
    return {
      id: row.id || credentialProfileId(row.provider_id, row.profile_name),
      providerId: row.provider_id,
      profileName: row.profile_name,
      authMethod: row.auth_method,
      ownership: row.ownership,
      credential,
      ...(expiresAt ? { expiresAt } : {}),
      metadata: {
        ...metadata,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
      },
    };
  }
}

function parseJsonField<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
