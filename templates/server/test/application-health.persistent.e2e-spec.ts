import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Public } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { createAdministrator } from '../src/accounts/create-administrator';
import { RateLimiterService } from '@zucker-framework/rate-limiter';
import { ACCOUNT_MAILER } from '../src/accounts/account.service';
import { BILLING_OPTIONS } from '../src/billing/billing.service';
import { JOBS_OPTIONS } from '../src/jobs/jobs.config';
import { DELIVERY_OPTIONS } from '../src/delivery/delivery.config';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_application_${randomUUID().replaceAll('-', '')}`;
@Controller('private-audit-probe')
class AuditProbeController {
  @Post()
  @Public()
  @AccessLogger({ action: 'private-audit-probe', module: 'test', logParameters: true, logResult: true })
  write(@Body() input: unknown) { return { privateConfiguration: input }; }
}

run('actual application health and durable HTTP audit composition', () => {
  let pool: Pool, app: INestApplication, directory: string;
  const previous = new Map<string, string | undefined>();
  function environment(name: string, value: string) { previous.set(name, process.env[name]); process.env[name] = value; }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.pathname !== '/cnipa_dev' && !/(?:_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema);
    directory = mkdtempSync(join(tmpdir(), 'zucker-application-health-'));
    environment('DATABASE_URL', url.href); environment('JWT_SECRET', 'synthetic-health-test-secret-long-enough');
    environment('FILES_STORAGE_PROVIDER', 'local'); environment('FILES_LOCAL_PATH', directory);
    environment('NODE_ENV', 'test');
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule], controllers: [AuditProbeController] })
      .overrideProvider(ACCOUNT_MAILER).useValue({ assertConfigured() {}, async send() { throw new Error('No email should be sent'); } })
      .overrideProvider(BILLING_OPTIONS).useValue({ providers: [], subscriptionProviders: [], webUrl: 'http://localhost:4202' })
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: 'synthetic-health-worker', concurrency: 1,
        scanIntervalMs: 1000, leaseMs: 30_000, heartbeatMs: 5000, shutdownWaitMs: 1000 })
      .overrideProvider(DELIVERY_OPTIONS).useValue({ accountScope: '', leaseMs: 30_000, heartbeatMs: 5000 }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
  });
  afterAll(async () => {
    try { await app?.close(); }
    finally {
      try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
        for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    }
  });

  it('serves one real readiness check against the migrated consumer schema', async () => {
    for (const route of ['/api/health', '/api/health/ready']) {
      const result = await request(app.getHttpServer()).get(route).expect(200);
      expect(result.body).toMatchObject({ status: 'up', checks: { database: { status: 'up', details: { connected: true, schemaReady: true } } } });
      expect(Object.keys(result.body.checks)).toEqual(['database']);
    }
  });

  it('fails readiness when an application table is missing while liveness remains healthy', async () => {
    await pool.query(`ALTER TABLE "${schema}".quota_reservations RENAME TO quota_reservations_unavailable`);
    try {
      const result = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
      expect(result.body.checks.database).toEqual({ status: 'down', details: { connected: true, schemaReady: false } });
      await request(app.getHttpServer()).get('/api/health/live').expect(200);
    } finally { await pool.query(`ALTER TABLE "${schema}".quota_reservations_unavailable RENAME TO quota_reservations`); }
    await request(app.getHttpServer()).get('/api/health/ready').expect(200);
  });

  it('reports dependency failure without returning database credentials or SQL diagnostics', async () => {
    const database = app.get<ApplicationDatabase>(DATABASE_ADAPTER);
    const failure = vi.spyOn(database, 'transaction').mockRejectedValueOnce(new Error('PRIVATE-CONNECTION-SENTINEL'));
    try {
      const result = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
      expect(result.body.checks.database).toEqual({ status: 'down', details: { error: 'Health check failed' } });
      expect(JSON.stringify(result.body)).not.toContain('PRIVATE-CONNECTION-SENTINEL');
    } finally { failure.mockRestore(); }
  });

  it('persists audit metadata but never controller-opted-in private bodies or responses', async () => {
    const sentinel = 'PRIVATE-DOCUMENT-AND-CONFIGURATION-SENTINEL';
    const result = await request(app.getHttpServer()).post('/api/private-audit-probe').send({ privateText: sentinel }).expect(201);
    expect(JSON.stringify(result.body)).toContain(sentinel);
    await expect.poll(async () => Number((await pool.query(`SELECT count(*) FROM "${schema}".access_logs WHERE action='private-audit-probe'`)).rows[0].count)).toBe(1);
    await expect.poll(async () => Number((await pool.query(`SELECT count(*) FROM "${schema}".operation_logs WHERE action='private-audit-probe'`)).rows[0].count)).toBe(1);
    const access = await pool.query(`SELECT * FROM "${schema}".access_logs WHERE action='private-audit-probe'`);
    const operations = await pool.query(`SELECT * FROM "${schema}".operation_logs WHERE action='private-audit-probe'`);
    expect(access.rows[0]).toMatchObject({ method: 'POST', parameters: null, result: null });
    expect(JSON.stringify([access.rows, operations.rows])).not.toContain(sentinel);
  });

  it('counts authenticated account reads once per user without spending the login write budget', async () => {
    const database = app.get<ApplicationDatabase>(DATABASE_ADAPTER);
    const username = 'synthetic_rate_reader', password = 'SyntheticReadBudget99!';
    const userId = await createAdministrator(database, { username, password, email: 'rate-reader@example.invalid' });
    const consume = vi.spyOn(app.get(RateLimiterService), 'consume');
    const login = () => request(app.getHttpServer()).post('/api/authorize/login')
      .set('Origin', 'http://localhost:4202').send({ username, password });
    try {
      const authenticated = await login().expect(200);
      const paths = ['me', 'sessions', 'api-keys', 'avatar', 'oauth/connections'];
      for (let visit = 0; visit < 5; visit++) for (const path of paths) {
        await request(app.getHttpServer()).get(`/api/authorize/${path}`)
          .set('Authorization', `Bearer ${authenticated.body.token}`).expect(200);
      }
      // `me` is read on every page load and has its own per-user budget (src/rate-limits.ts).
      expect(consume.mock.calls.filter(([name, key]) => name === 'api-default' && key === userId)).toHaveLength(20);
      expect(consume.mock.calls.filter(([name, key]) => name === 'session-read' && key === userId)).toHaveLength(5);
      expect(consume.mock.calls.filter(([name]) => name === 'accounts')).toHaveLength(1);
      await login().expect(200);
      expect(consume.mock.calls.filter(([name]) => name === 'accounts')).toHaveLength(2);
    } finally { consume.mockRestore(); }
  });
});
