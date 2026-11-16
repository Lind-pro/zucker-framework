import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';

/** Test-only SQL runtime: the default embedded tests can also exercise the
 * exact assertions over a real, explicitly selected loopback PostgreSQL pool. */
export interface TestSqlConnection {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; affectedRows: number }>;
}
export interface TestSqlRuntime extends TestSqlConnection {
  exec(sql: string): Promise<unknown>;
  transaction<T>(work: (tx: TestSqlConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function pooledConnection(client: Pool | PoolClient): TestSqlConnection {
  return { async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    const result = await client.query<T>(sql, values);
    return { rows: result.rows, affectedRows: result.rowCount ?? 0 };
  } };
}

export async function transactionalSqlRuntime(prefix: string, databaseUrl?: string): Promise<TestSqlRuntime> {
  if (!databaseUrl) {
    const pg = await PGlite.create();
    return {
      async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        const result = await pg.query<T>(sql, values);
        return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
      },
      exec: sql => pg.exec(sql),
      transaction: work => pg.transaction(tx => work({ async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        const result = await tx.query<T>(sql, values);
        return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
      } })),
      close: () => pg.close(),
    };
  }
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
    throw new Error('Use an explicitly isolated loopback *_test database');
  }
  if (!/^[a-z_]+$/.test(prefix)) throw new Error('Invalid test schema prefix');
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href, max: 1 });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); }
  catch (error) { await admin.end(); throw error; }
  const pool = new Pool({ connectionString: url.href, max: 10, options: `-c search_path=${schema}` });
  return {
    ...pooledConnection(pool),
    exec: sql => pool.query(sql),
    async transaction<T>(work: (tx: TestSqlConnection) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(pooledConnection(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async close() {
      try { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    },
  };
}
