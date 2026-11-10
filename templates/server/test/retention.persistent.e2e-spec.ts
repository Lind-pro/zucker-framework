import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ApplicationDatabase } from '../src/database';
import { RetentionService, retentionOptionsFromEnvironment } from '../src/maintenance/retention';
import type { JobsService } from '../src/jobs/jobs.service';
import { SUBSCRIPTION_RECONCILE_JOB } from '../src/billing/billing-runtime';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_retention_${randomUUID().replaceAll('-', '')}`;

run('operational table retention', () => {
  let pool: Pool, scoped: Pool, db: ApplicationDatabase;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    // Trigger functions use unqualified names, so direct inserts need the schema on the search path.
    scoped = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000, options: `-c search_path=${schema}` });
    url.searchParams.set('schema', schema); db = new ApplicationDatabase(url.href);
  });
  afterAll(async () => {
    try { await db?.disconnect(); await scoped?.end(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('purges only aged operational rows and keeps user-visible jobs', async () => {
    const old = new Date('2020-01-01T00:00:00Z'), now = new Date();
    const q = (sql: string, values: unknown[] = []) => scoped.query(sql.replaceAll('{s}', `"${schema}"`), values);
    await q(`INSERT INTO {s}.users (id, username, password, name, "typeId") VALUES ('u1','retention','x','r','member')`);
    await q(`INSERT INTO {s}.access_logs (id, action, "requestTime") VALUES ('old','a',$1),('new','a',$2)`, [old, now]);
    await q(`INSERT INTO {s}.account_sessions (id,"userId","refreshJti","expiresAt","revokedAt") VALUES
      ('s-old','u1','j1',$1,NULL),('s-revoked','u1','j2',$2,$1),('s-live','u1','j3',$2,NULL)`, [old, new Date(now.getTime() + 86_400_000)]);
    const job = (id: string, kind: string, status: string, updatedAt: Date) => q(`INSERT INTO {s}.async_jobs
      (id,kind,"resourceType","resourceId","userId",status,"maxAttempts","idempotencyKey","idempotencyFingerprint","handlerVersion",payload,"updatedAt")
      VALUES ($1,$2,'r',$1,'u1',$3::{s}.async_job_status,3,$1,'f','1','{}'::jsonb,$4)`, [id, kind, status, updatedAt]);
    await job('maintenance-old', SUBSCRIPTION_RECONCILE_JOB, 'COMPLETED', old);
    await job('maintenance-failed', SUBSCRIPTION_RECONCILE_JOB, 'FAILED', old);
    await job('record-old', 'record', 'COMPLETED', old);
    const service = new RetentionService(db, { registerWakeSource() {} } as unknown as JobsService, retentionOptionsFromEnvironment({}));
    expect(await service.purge(now)).toEqual({ apiKeyUsage: 0, accessLogs: 1, sessions: 2, maintenanceJobs: 1 });
    expect((await q('SELECT id FROM {s}.access_logs')).rows).toEqual([{ id: 'new' }]);
    expect((await q('SELECT id FROM {s}.account_sessions')).rows).toEqual([{ id: 's-live' }]);
    expect((await q('SELECT id FROM {s}.async_jobs ORDER BY id')).rows.map(row => row.id)).toEqual(['maintenance-failed', 'record-old']);
    expect(await service.purge(now)).toEqual({ apiKeyUsage: 0, accessLogs: 0, sessions: 0, maintenanceJobs: 0 });
  });
});
