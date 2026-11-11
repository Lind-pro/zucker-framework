import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { AccountService } from '../src/accounts/account.service';
import { RUNTIME_ENVIRONMENT } from '../src/runtime-settings/runtime-settings.tokens';
import { TransactionalMail } from '@zucker-framework/back-office/mail';
import { BillingReceiptMail } from '../src/mail/billing-receipt.runtime';

/**
 * Minimal local SMTP stub (a mail catcher without AUTH): accepts any envelope and records raw DATA.
 * Loopback only. It must not advertise AUTH: the shared EmailProvider passes an empty `auth.user`
 * when SMTP_USER is unset, which nodemailer rejects against a server offering AUTH.
 */
function smtpStub(): Promise<{ server: Server; port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = createServer(socket => {
    let buffer = '', data = false;
    socket.write('220 stub ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return;
          messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 queued\r\n'); continue;
        }
        const line = buffer.indexOf('\r\n'); if (line < 0) return;
        const command = buffer.slice(0, line); buffer = buffer.slice(line + 2);
        const verb = command.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') socket.write('250-stub\r\n250 8BITMIME\r\n');
        else if (verb === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (verb === 'QUIT') { socket.end('221 bye\r\n'); return; }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ server, port: (server.address() as AddressInfo).port, messages })));
}
/** Decodes RFC 2047 subjects and a quoted-printable body enough to search them. */
function decoded(raw: string): string {
  const qp = raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const bytes = Buffer.from(qp, 'latin1').toString('utf8');
  const words = [...raw.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi)].map(match => Buffer.from(match[1]!, 'base64').toString('utf8'));
  return [...words, bytes].join('\n');
}

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_acctmail_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticMail9!';

run('account and receipt mail through MailService and an SMTP stub', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, smtp: Awaited<ReturnType<typeof smtpStub>>;
  const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;

  beforeAll(async () => {
    smtp = await smtpStub();
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const environment = Object.freeze({ WEB_URL: origin, SITE_NAME: 'Synthetic <Site>', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'sender@example.invalid' });
    @Global() @Module({ providers: [{ provide: RUNTIME_ENVIRONMENT, useValue: environment }], exports: [RUNTIME_ENVIRONMENT] })
    class SyntheticEnvironment {}
    const limits = { points: 3000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [SyntheticEnvironment, ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-account-mail-jwt-at-least-32-chars', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      AccountModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); smtp?.server.close(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('sends localised verification and welcome mail, logs them without tickets, and verifies through the fragment link', async () => {
    await post('register', { username: 'mailuser', email: 'mailuser@example.invalid', password, locale: 'zh' }).expect(201);
    expect(smtp.messages).toHaveLength(1);
    const verification = decoded(smtp.messages[0]!);
    expect(verification).toContain('验证你的邮箱');
    expect(verification).toContain('Synthetic &lt;Site&gt;');
    const ticket = /\/zh\/verify-email#ticket=([A-Za-z0-9_-]{43})/.exec(verification)?.[1];
    expect(ticket).toBeTruthy();
    const logs = await q('SELECT template, status, metadata, "userId" FROM "S".email_logs ORDER BY "createdAt"');
    expect(logs).toEqual([{ template: 'account.verify', status: 'success', metadata: { purpose: 'verify-email' }, userId: expect.any(String) }]);
    expect(JSON.stringify(logs)).not.toContain(ticket);
    await post('verify-email', { ticket }).expect(200);
    await app.get(AccountService).settled();
    expect(smtp.messages).toHaveLength(2);
    expect(decoded(smtp.messages[1]!)).toContain('欢迎你，mailuser');
  });

  it('sends one escaped receipt per fulfilled order', async () => {
    const owner = (await q(`SELECT id FROM "S".users WHERE username = 'mailuser'`))[0].id as string;
    await q(`INSERT INTO "S".billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
      "creationState", "captureState", state, "fulfilledAt") VALUES ('order_synthetic', $1, 'pack', 'fake', 'scope', $2, 'https://x.invalid', 'https://x.invalid',
      'ck', 'cap', 'created', 'captured', 'fulfilled', now())`, [owner, JSON.stringify({ description: '<b>Pack</b>', money: { amount: '9.00', currency: 'USD' } })]);
    const receipts = new BillingReceiptMail(database, app.get(TransactionalMail));
    expect(await receipts.deliver('order_synthetic')).toEqual({ orderId: 'order_synthetic', sent: true });
    expect(await receipts.deliver('order_synthetic')).toMatchObject({ sent: false, reason: 'already-sent' });
    expect(smtp.messages).toHaveLength(3);
    const receipt = decoded(smtp.messages[2]!);
    expect(receipt).toContain('&lt;b&gt;Pack&lt;/b&gt;');
    expect(receipt).toContain('9.00 USD');
    expect(receipt).toContain(`${origin}/zh/billing/orders`);
  });
});
