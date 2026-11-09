import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';

/**
 * Guards that every correctness-bearing index/constraint of the back-office tables is representable
 * in schema.prisma: the migrations, applied to an empty schema, must not differ from schema.prisma
 * for these tables (`prisma migrate diff` would otherwise propose dropping, e.g., a partial unique
 * index on the next `migrate dev`). Older tables have known, unrelated drift and are not checked here.
 */
const BACK_OFFICE_TABLES = ['subscription_plans', 'subscription_plan_prices', 'subscription_plan_price_refs', 'user_subscriptions',
  'user_subscription_payments', 'email_templates', 'email_logs', 'quota_reservations', 'quota_usage', 'billing_orders'];

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('back-office schema has no drift between migrations and schema.prisma', () => {
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

  it('prisma migrate diff proposes nothing for the back-office tables', async () => {
    const scoped = new URL(url.href);
    scoped.searchParams.set('schema', schema);
    const { stdout } = await promisify(execFile)(resolve('node_modules/.bin/prisma'),
      ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--script'],
      { env: { ...process.env, DATABASE_URL: scoped.href }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const statements = stdout.split(';').map(statement => statement.replace(/--.*$/gm, '').trim()).filter(Boolean);
    // The table a statement changes: ALTER/CREATE/DROP TABLE "t", CREATE INDEX … ON "t", DROP INDEX "t_…".
    const subject = (statement: string) => /^(?:ALTER|CREATE|DROP) TABLE\s+(?:IF (?:NOT )?EXISTS\s+)?"([^"]+)"/i.exec(statement)?.[1]
      ?? /^CREATE (?:UNIQUE )?INDEX\s+"[^"]+"\s+ON\s+"([^"]+)"/i.exec(statement)?.[1]
      ?? /^DROP INDEX\s+"([^"]+)"/i.exec(statement)?.[1];
    const drift = statements.filter(statement => {
      const name = subject(statement);
      return !!name && BACK_OFFICE_TABLES.some(table => name === table || name.startsWith(`${table}_`));
    });
    expect(drift).toEqual([]);
    // The guard is live: the generated diff is parsed (an unrelated older table is known to drift).
    expect(stdout.length).toBeGreaterThan(0);
  }, 150_000);
});
