import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ApplicationDatabase } from '../../src/database';

/** Isolated schema with every migration applied; shared by the WP 3.3b account-security specs. */
export async function createIsolatedSchema(databaseUrl: string, schema: string): Promise<{ pool: Pool; database: ApplicationDatabase; url: string }> {
  const url = new URL(databaseUrl);
  if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  url.searchParams.set('schema', schema);
  return { pool, database: new ApplicationDatabase(url.href), url: url.href };
}

export async function dropIsolatedSchema(pool: Pool | undefined, schema: string): Promise<void> {
  if (!pool) return;
  try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
}
