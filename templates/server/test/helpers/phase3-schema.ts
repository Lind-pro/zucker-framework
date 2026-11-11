/**
 * Test-only helper for the Phase 3 specs: applies every Prisma migration into a throw-away schema of the
 * designated test database and drops it again. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

export interface IsolatedSchema { pool: Pool; schema: string; url: URL; drop(): Promise<void> }

export async function createIsolatedSchema(prefix: string, databaseUrl: string): Promise<IsolatedSchema> {
  const url = new URL(databaseUrl);
  if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); await pool.end(); throw error; } finally { client.release(); }
  url.searchParams.set('schema', schema);
  return { pool, schema, url, async drop() { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } };
}
