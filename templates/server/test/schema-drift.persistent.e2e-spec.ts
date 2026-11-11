import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';

/**
 * Guards that every index/constraint created by the migrations is representable in the Prisma schema
 * (prisma/schema.prisma + prisma/models/*.prisma): the migrations, applied to an empty schema, must not
 * differ from it for ANY table (`prisma migrate diff` would otherwise propose dropping, e.g., a foreign key
 * or a partial unique index on the next `migrate dev`). Triggers, functions and CHECK constraints are
 * outside Prisma's model and are not compared. Phase 3 (WP 3.Z) aligned the older billing refund and
 * subscription relations, so the whole diff must now be empty; this also covers the Phase 3 feature
 * tables (inbox, feedback, promotions, referrals, account security, file intents).
 */
const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('the schema has no drift between migrations and the Prisma schema', () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://invalid/invalid');
  const schema = `zucker_drift_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;

  beforeAll(async () => {
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const item of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', item.name, 'migration.sql'), 'utf8')
          .replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }, 60_000);
  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  it('prisma migrate diff proposes nothing for any table', async () => {
    const scoped = new URL(url.href);
    scoped.searchParams.set('schema', schema);
    const { stdout } = await promisify(execFile)(resolve('node_modules/.bin/prisma'),
      // The whole prisma/ directory: schema.prisma plus every feature fragment in prisma/models/.
      ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma', '--script'],
      { env: { ...process.env, DATABASE_URL: scoped.href }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const statements = stdout.split(';').map(statement => statement.replace(/--.*$/gm, '').trim()).filter(Boolean);
    expect(statements).toEqual([]);
    // The guard is live: Prisma printed its (empty) migration script.
    expect(stdout).toMatch(/empty migration/i);
  }, 150_000);
});
