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

export interface PostgresCredentialProfileStoreOptions {
  pool: PostgresPoolLike;
  tableName?: string;
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

  constructor(options: PostgresCredentialProfileStoreOptions) {
    this.pool = options.pool;
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
    const result = await this.pool.query<CredentialProfileRow>(
      `SELECT * FROM ${this.tableName} WHERE provider_id = $1 AND profile_name = $2 LIMIT 1`,
      [providerId, profileName],
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  async list(providerId?: string): Promise<CredentialProfile[]> {
    const result = providerId
      ? await this.pool.query<CredentialProfileRow>(
          `SELECT * FROM ${this.tableName} WHERE provider_id = $1 ORDER BY provider_id, profile_name`,
          [providerId],
        )
      : await this.pool.query<CredentialProfileRow>(
          `SELECT * FROM ${this.tableName} ORDER BY provider_id, profile_name`,
        );
    return result.rows.map((row) => this.fromRow(row));
  }

  async save(profile: CredentialProfile): Promise<void> {
    await this.pool.query(
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
        JSON.stringify(profile.credential),
        JSON.stringify(profile.metadata),
        profile.expiresAt ? new Date(profile.expiresAt) : null,
        new Date(profile.metadata.createdAt),
        new Date(profile.metadata.updatedAt),
      ],
    );
  }

  async remove(providerId: string, profileName = 'default'): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE provider_id = $1 AND profile_name = $2`,
      [providerId, profileName],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async runExclusive<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [profileId]);
      return await operation();
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [profileId]);
      } finally {
        client.release();
      }
    }
  }

  private fromRow(row: CredentialProfileRow): CredentialProfile {
    const credential = parseJsonField<CredentialMaterial>(row.credential);
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
