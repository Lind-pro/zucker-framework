/**
 * Feedback (WP 3.1) test-engineer matrix on PostgreSQL + HTTP: concurrency (same key, open-item cap,
 * revision CAS), audit atomicity with a failing notifier, input rejection tables, policy off and
 * environment pin, and the section-4 gates (cross-user access, viewer 403, no private fields leaked).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { FEEDBACK_POLICIES, FEEDBACK_POLICY, FeedbackModule, FeedbackService, feedbackDeletionContributor, type FeedbackNotifier } from '../src/feedback';
import { createIsolatedSchema, type IsolatedSchema } from './helpers/phase3-schema';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-feedback-gates-jwt-secret-32-chars',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt' };
type User = { id: string; token: string };

run('feedback gates and concurrency (PostgreSQL + HTTP)', () => {
  let app: INestApplication, db: IsolatedSchema, database: ApplicationDatabase, policies: PolicyService, service: FeedbackService;
  let owner: User, other: User, staff: User, viewer: User, nobody: User;
  let notifierMode: 'ok' | 'throw' = 'ok';
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const notified: string[] = [];
  const notifier: FeedbackNotifier = { async notifyReply(_tx, event) { if (notifierMode === 'throw') throw new Error('notifier down'); notified.push(event.feedbackId); } };
  const server = () => app.getHttpServer();
  const as = (req: request.Test, user: User) => req.set('Authorization', `Bearer ${user.token}`).set('Origin', origin);
  const submit = (user: User, key: string, body: object) => as(request(server()).post('/api/feedback'), user).set('Idempotency-Key', key).send(body);
  const patch = (user: User, id: string, body: object) => as(request(server()).patch(`/api/management/feedback/${id}`), user).send(body);
  const rows = async (sql: string, values: unknown[] = []) => database.transaction(async tx => (await tx.query<Record<string, unknown>>(sql, values)).rows);
  async function setPolicy(values: Record<string, unknown>) {
    const view = await policies.view('feedback') as { revision: number };
    await policies.save('system', 'feedback', { expectedRevision: view.revision, values });
  }
  async function member(username: string, permissions: string[] = []): Promise<User> {
    const email = `${username}@example.invalid`, password = 'SyntheticFeedback9!';
    const send = (path: string, body: object) => request(server()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200);
    for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: login.body.userId, permissionId: permission, grantType: 'grant' } });
    return { id: login.body.userId as string, token: login.body.token as string };
  }

  beforeAll(async () => {
    db = await createIsolatedSchema('zucker_fbgates', databaseUrl!);
    database = new ApplicationDatabase(db.url.href);
    process.env.ACCOUNT_ORIGINS = origin;
    const limits = { points: 5000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [
      EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      // The production budget (5/h) is covered by feedback.persistent; here the budget is lifted so the matrix is not throttled.
      ZuckerRateLimiterModule.forRoot({ globalGuard: false, limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits,
        'session-read': limits, 'api-default': limits, 'feedback-submit': { points: 5000, duration: 3600 } } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...FEEDBACK_POLICIES] }),
      AccountModule, FeedbackModule.forRoot({ notifier: { useFactory: () => notifier } }),
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    policies = app.get(PolicyService); service = app.get(FeedbackService);
    for (const id of ['feedback:query', 'feedback:update']) await database.model('permissions').create({ data: { id, name: id } });
    owner = await member('gowner'); other = await member('gother'); nobody = await member('gnobody');
    staff = await member('gstaff', ['feedback:query', 'feedback:update']); viewer = await member('gviewer', ['feedback:query']);
  }, 60_000);
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { await db?.drop(); } });

  describe('concurrency', () => {
    it('10 concurrent submits with one Idempotency-Key create exactly one row and return one id', async () => {
      const body = { type: 'bug', message: 'concurrent same key' };
      const responses = await Promise.all(Array.from({ length: 10 }, () => submit(owner, 'conc-same-key-1', body)));
      expect(responses.map(response => response.status)).toEqual(Array(10).fill(201));
      expect(new Set(responses.map(response => response.body.id)).size).toBe(1);
      expect((await rows('SELECT COUNT(*)::int AS n FROM feedback WHERE "ownerId"=$1 AND "requestKey"=$2', [owner.id, 'conc-same-key-1']))[0]!.n).toBe(1);
    });

    it('the same key from two different users makes two independent rows (keys are per owner)', async () => {
      const [a, b] = await Promise.all([submit(owner, 'shared-key-0001', { type: 'idea', message: 'a' }), submit(other, 'shared-key-0001', { type: 'idea', message: 'b' })]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.id).not.toBe(b.body.id);
      expect(b.body.message).toBe('b');
    });

    it('same key, concurrent but different content: one wins, the rest are 409 FEEDBACK_IDEMPOTENCY_CONFLICT', async () => {
      const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => submit(other, 'conc-diff-key-1', { type: 'idea', message: `variant ${index}` })));
      expect(responses.filter(response => response.status === 201)).toHaveLength(1);
      const conflicts = responses.filter(response => response.status === 409);
      expect(conflicts).toHaveLength(5);
      expect(JSON.stringify(conflicts[0]!.body)).toContain('FEEDBACK_IDEMPOTENCY_CONFLICT');
      expect((await rows('SELECT COUNT(*)::int AS n FROM feedback WHERE "ownerId"=$1 AND "requestKey"=$2', [other.id, 'conc-diff-key-1']))[0]!.n).toBe(1);
    });

    it('maxOpenPerUser holds under 12 concurrent submits with distinct keys; closing an item frees a slot', async () => {
      const user = await member('gcap');
      await setPolicy({ maxOpenPerUser: 3 });
      try {
        const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => submit(user, `cap-key-${index}-xxxx`, { type: 'other', message: `m${index}` })));
        expect(responses.filter(response => response.status === 201)).toHaveLength(3);
        const refused = responses.filter(response => response.status === 409);
        expect(refused).toHaveLength(9);
        expect(JSON.stringify(refused[0]!.body)).toContain('FEEDBACK_TOO_MANY_OPEN');
        expect((await rows('SELECT COUNT(*)::int AS n FROM feedback WHERE "ownerId"=$1', [user.id]))[0]!.n).toBe(3);
        // A replay of an accepted key still answers 201 at the cap (no new row), a refused key stays refused.
        const accepted = responses.find(response => response.status === 201)!;
        const replay = await submit(user, `cap-key-${responses.indexOf(accepted)}-xxxx`, { type: 'other', message: `m${responses.indexOf(accepted)}` }).expect(201);
        expect(replay.body.id).toBe(accepted.body.id);
        // Only open and in_progress items count: resolving one frees exactly one slot.
        await patch(staff, accepted.body.id, { expectedRevision: 0, status: 'resolved' }).expect(200);
        await submit(user, 'cap-after-resolve-1', { type: 'other', message: 'after' }).expect(201);
        await submit(user, 'cap-after-resolve-2', { type: 'other', message: 'after2' }).expect(409);
      } finally { await setPolicy({ maxOpenPerUser: 20 }); }
    });

    it('two staff members saving the same revision at once: exactly one 200, one 409 FEEDBACK_REVISION_CONFLICT, one audit row', async () => {
      const created = await submit(owner, 'cas-race-key-01', { type: 'question', message: 'race' }).expect(201);
      const second = await member('gstaff2', ['feedback:query', 'feedback:update']);
      const results = await Promise.all([patch(staff, created.body.id, { expectedRevision: 0, status: 'in_progress' }),
        patch(second, created.body.id, { expectedRevision: 0, status: 'closed' })]);
      expect(results.map(result => result.status).sort()).toEqual([200, 409]);
      const loser = results.find(result => result.status === 409)!;
      expect(JSON.stringify(loser.body)).toContain('FEEDBACK_REVISION_CONFLICT');
      expect((await rows('SELECT revision FROM feedback WHERE id=$1', [created.body.id]))[0]!.revision).toBe(1);
      expect(await rows(`SELECT 1 FROM operation_logs WHERE module='feedback' AND "targetId"=$1`, [created.body.id])).toHaveLength(1);
    });
  });

  describe('atomicity', () => {
    it('a failing notifier rolls back the reply, the revision bump and the audit row; a retry then succeeds', async () => {
      const created = await submit(owner, 'notify-fail-key-1', { type: 'bug', message: 'needs reply' }).expect(201);
      const id = created.body.id as string;
      notifierMode = 'throw';
      try { await patch(staff, id, { expectedRevision: 0, status: 'resolved', reply: 'will not stick', staffNote: 'note' }).expect(500); }
      finally { notifierMode = 'ok'; }
      const [row] = await rows('SELECT status, reply, "staffNote", "handledBy", "repliedAt", revision FROM feedback WHERE id=$1', [id]);
      expect(row).toEqual({ status: 'open', reply: null, staffNote: null, handledBy: null, repliedAt: null, revision: 0 });
      expect(await rows(`SELECT 1 FROM operation_logs WHERE module='feedback' AND "targetId"=$1`, [id])).toHaveLength(0);
      expect(notified).not.toContain(id);
      const retried = await patch(staff, id, { expectedRevision: 0, status: 'resolved', reply: 'sticks now' }).expect(200);
      expect(retried.body).toMatchObject({ revision: 1, reply: 'sticks now' });
      expect(notified).toContain(id);
      expect(await rows(`SELECT 1 FROM operation_logs WHERE module='feedback' AND "targetId"=$1`, [id])).toHaveLength(1);
    });

    it('a status-only or note-only change does not notify; clearing a reply clears repliedAt; a no-op neither bumps revision nor audits', async () => {
      const created = await submit(owner, 'no-notify-key-01', { type: 'idea', message: 'quiet' }).expect(201);
      const id = created.body.id as string, before = notified.length;
      await patch(staff, id, { expectedRevision: 0, status: 'in_progress', staffNote: 'looking' }).expect(200);
      expect(notified.length).toBe(before);
      const replied = await patch(staff, id, { expectedRevision: 1, reply: 'hello' }).expect(200);
      expect(replied.body.repliedAt).not.toBeNull();
      expect(notified.length).toBe(before + 1);
      const noop = await patch(staff, id, { expectedRevision: 2, reply: 'hello', status: 'in_progress' }).expect(200);
      expect(noop.body.revision).toBe(2);
      expect(await rows(`SELECT 1 FROM operation_logs WHERE module='feedback' AND "targetId"=$1`, [id])).toHaveLength(2);
      const cleared = await patch(staff, id, { expectedRevision: 2, reply: '' }).expect(200);
      expect(cleared.body).toMatchObject({ reply: null, repliedAt: null, revision: 3 });
      expect(notified.length).toBe(before + 1);
    });
  });

  describe('input rejection', () => {
    const rejected: Array<[string, unknown]> = [
      ['protocol-relative', '//evil.example'], ['absolute url', 'https://evil.example/x'], ['javascript scheme', 'javascript:alert(1)'], ['backslash', '/a\\b'],
      ['query string', '/a?token=1'], ['fragment', '/a#x'], ['space', '/a b'], ['tab', '/a\tb'], ['newline', '/a\nb'], ['nul', '/a\u0000b'], ['DEL', '/a\u007fb'],
      ['relative', 'account/files'], ['too long (513)', `/${'a'.repeat(512)}`], ['non-string', 42], ['object', { path: '/a' }], ['array', ['/a']],
    ];
    it.each(rejected)('pagePath %s is refused with 400 FEEDBACK_INVALID and stores nothing', async (_label, pagePath) => {
      const before = (await rows('SELECT COUNT(*)::int AS n FROM feedback'))[0]!.n;
      const key = `path-${randomUUID().slice(0, 12)}`;
      await expect(service.submit(other.id, key, { type: 'idea', message: 'hi', pagePath })).rejects.toMatchObject({ status: 400, response: { code: 'FEEDBACK_INVALID' } });
      expect((await rows('SELECT COUNT(*)::int AS n FROM feedback'))[0]!.n).toBe(before);
    });
    it('boundary and ordinary paths are accepted (512 chars, localized, trailing slash, empty and null mean none)', async () => {
      const user = await member('gpaths');
      for (const [index, pagePath] of [`/${'a'.repeat(511)}`, '/zh/account/feedback', '/billing/', '', null, undefined].entries())
        await expect(service.submit(user.id, `ok-path-key-${index}`, { type: 'idea', message: 'hi', pagePath })).resolves.toMatchObject({ type: 'idea' });
    });
    it('refuses unknown keys (mass assignment), bad types, empty or control-character text and bad Idempotency-Key values over HTTP', async () => {
      const user = await member('ginputs');
      const bad: Array<[string, object, string | undefined]> = [
        ['owner override', { type: 'bug', message: 'x', ownerId: other.id }, 'inp-key-000001'],
        ['status override', { type: 'bug', message: 'x', status: 'resolved' }, 'inp-key-000002'],
        ['reply override', { type: 'bug', message: 'x', reply: 'staff said' }, 'inp-key-000003'],
        ['unknown type', { type: 'rant', message: 'x' }, 'inp-key-000004'],
        ['blank message', { type: 'bug', message: '   ' }, 'inp-key-000005'],
        ['message too long', { type: 'bug', message: 'x'.repeat(4001) }, 'inp-key-000006'],
        ['control char', { type: 'bug', message: 'a\u0007b' }, 'inp-key-000007'],
        ['bad locale', { type: 'bug', message: 'x', locale: 'en_US<script>' }, 'inp-key-000008'],
        ['missing key', { type: 'bug', message: 'x' }, undefined],
        ['short key', { type: 'bug', message: 'x' }, 'short'],
        ['key with space', { type: 'bug', message: 'x' }, 'key with spaces!'],
        ['129-char key', { type: 'bug', message: 'x' }, 'k'.repeat(129)],
      ];
      for (const [label, body, key] of bad) {
        const req = as(request(server()).post('/api/feedback'), user); if (key !== undefined) req.set('Idempotency-Key', key);
        const response = await req.send(body);
        expect(response.status, label).toBe(400);
      }
      expect(await rows('SELECT 1 FROM feedback WHERE "ownerId"=$1', [user.id])).toHaveLength(0);
    });
    it('staff update rejects unknown fields, non-integer or negative revision, unknown status and oversize text; list rejects unknown filters', async () => {
      const created = await submit(owner, 'staff-input-key-1', { type: 'bug', message: 'x' }).expect(201);
      for (const body of [{ expectedRevision: 0, ownerId: other.id }, { expectedRevision: 0, requestKey: 'k' }, { expectedRevision: -1, status: 'closed' },
        { expectedRevision: 1.5, status: 'closed' }, { expectedRevision: '0', status: 'closed' }, { status: 'closed' }, { expectedRevision: 0 },
        { expectedRevision: 0, status: 'deleted' }, { expectedRevision: 0, reply: 'x'.repeat(2001) }, { expectedRevision: 0, staffNote: 'x'.repeat(2001) }, { expectedRevision: 0, reply: 5 }])
        expect((await patch(staff, created.body.id, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect((await rows('SELECT revision FROM feedback WHERE id=$1', [created.body.id]))[0]!.revision).toBe(0);
      for (const query of ['?status=bogus', '?type=bogus', '?foo=1', '?page=0', '?pageSize=101', '?page=1.5'])
        expect((await as(request(server()).get(`/api/management/feedback${query}`), staff)).status, query).toBe(400);
      // A hostile filter value is data, never SQL.
      const hostile = await as(request(server()).get(`/api/management/feedback?ownerId=${encodeURIComponent("x' OR '1'='1")}`), staff).expect(200);
      expect(hostile.body.total).toBe(0);
      await patch(staff, 'does-not-exist', { expectedRevision: 0, status: 'closed' }).expect(404);
    });
    it('mine rejects unknown query keys and out-of-range paging', async () => {
      for (const query of ['?ownerId=x', '?page=0', '?pageSize=51', '?page=abc']) expect((await as(request(server()).get(`/api/feedback/mine${query}`), owner)).status, query).toBe(400);
    });
  });

  describe('policy', () => {
    it('disabled policy: new submissions are 403 FEEDBACK_DISABLED, a replay of a stored key and the owner list still work', async () => {
      const user = await member('gpolicy');
      const first = await submit(user, 'policy-key-0001', { type: 'idea', message: 'before off' }).expect(201);
      await setPolicy({ enabled: false });
      try {
        const refused = await submit(user, 'policy-key-0002', { type: 'idea', message: 'while off' }).expect(403);
        expect(JSON.stringify(refused.body)).toContain('FEEDBACK_DISABLED');
        expect((await submit(user, 'policy-key-0001', { type: 'idea', message: 'before off' }).expect(201)).body.id).toBe(first.body.id);
        expect((await as(request(server()).get('/api/feedback/mine'), user).expect(200)).body.total).toBe(1);
        // Staff keep working while submissions are off.
        await patch(staff, first.body.id, { expectedRevision: 0, reply: 'still answered' }).expect(200);
        // The public config exposes `enabled` only, never the per-user cap.
        const config = await request(server()).get('/api/site/public/config').expect(200);
        expect(JSON.stringify(config.body)).toContain('"enabled":false');
        expect(JSON.stringify(config.body)).not.toContain('maxOpenPerUser');
      } finally { await setPolicy({ enabled: true }); }
      await submit(user, 'policy-key-0002', { type: 'idea', message: 'while off' }).expect(201);
    });
    it('environment pins override saved values, report their source, and an invalid pin fails at construction', async () => {
      await setPolicy({ enabled: true, maxOpenPerUser: 20 });
      const pinned = new PolicyService(database, [FEEDBACK_POLICY], { POLICY_FEEDBACK_ENABLED: 'false', POLICY_FEEDBACK_MAX_OPEN_PER_USER: '1' });
      expect(await pinned.get(FEEDBACK_POLICY)).toEqual({ enabled: false, maxOpenPerUser: 1 });
      const view = await pinned.view('feedback');
      expect(view.fields.map(field => [field.key, field.source, field.pinnedByEnvironment])).toEqual([['enabled', 'environment', true], ['maxOpenPerUser', 'environment', true]]);
      const pinnedService = new FeedbackService(database, pinned);
      await expect(pinnedService.submit(owner.id, 'pin-key-000001', { type: 'idea', message: 'x' })).rejects.toMatchObject({ status: 403 });
      const capped = new FeedbackService(database, new PolicyService(database, [FEEDBACK_POLICY], { POLICY_FEEDBACK_MAX_OPEN_PER_USER: '1' }));
      const user = await member('gpin');
      await capped.submit(user.id, 'pin-key-000002', { type: 'idea', message: 'one' });
      await expect(capped.submit(user.id, 'pin-key-000003', { type: 'idea', message: 'two' })).rejects.toMatchObject({ status: 409 });
      for (const bad of [{ POLICY_FEEDBACK_ENABLED: 'maybe' }, { POLICY_FEEDBACK_MAX_OPEN_PER_USER: 'many' }])
        expect(() => new PolicyService(database, [FEEDBACK_POLICY], bad)).toThrow(/not a valid/);
      // The live service is untouched by the pinned copies.
      expect(await policies.get(FEEDBACK_POLICY)).toEqual({ enabled: true, maxOpenPerUser: 20 });
    });
    it('the policy refuses out-of-range saved values', async () => {
      const view = await policies.view('feedback') as { revision: number };
      for (const values of [{ maxOpenPerUser: 0 }, { maxOpenPerUser: 1001 }, { maxOpenPerUser: 1.5 }, { enabled: 'yes' }, { unknown: 1 }])
        await expect(policies.save('system', 'feedback', { expectedRevision: view.revision, values } as never)).rejects.toBeDefined();
    });
  });

  describe('security gates', () => {
    it('gate 1: anonymous is 401; a signed-in user without feedback permissions is 403 on every management route', async () => {
      const created = await submit(owner, 'gate1-key-00001', { type: 'bug', message: 'gate' }).expect(201);
      await request(server()).get('/api/feedback/mine').expect(401);
      await request(server()).post('/api/feedback').set('Origin', origin).set('Idempotency-Key', 'anon-key-00001').send({ type: 'bug', message: 'x' }).expect(401);
      await request(server()).get('/api/management/feedback').expect(401);
      for (const user of [nobody, owner]) {
        await as(request(server()).get('/api/management/feedback'), user).expect(403);
        await as(request(server()).get(`/api/management/feedback/${created.body.id}`), user).expect(403);
        await patch(user, created.body.id, { expectedRevision: 0, status: 'closed' }).expect(403);
      }
      expect((await rows('SELECT status FROM feedback WHERE id=$1', [created.body.id]))[0]!.status).toBe('open');
    });
    it('gate 1: viewer (feedback:query) reads but gets 403 on PATCH, with no state change and no audit row', async () => {
      const created = await submit(other, 'gate1-viewer-key1', { type: 'bug', message: 'viewer target' }).expect(201);
      await as(request(server()).get('/api/management/feedback'), viewer).expect(200);
      await as(request(server()).get(`/api/management/feedback/${created.body.id}`), viewer).expect(200);
      await patch(viewer, created.body.id, { expectedRevision: 0, reply: 'viewer reply', status: 'closed' }).expect(403);
      await request(server()).patch(`/api/management/feedback/${created.body.id}`).send({ expectedRevision: 0, status: 'closed' }).expect(401);
      const [row] = await rows('SELECT status, reply, revision FROM feedback WHERE id=$1', [created.body.id]);
      expect(row).toEqual({ status: 'open', reply: null, revision: 0 });
      expect(await rows(`SELECT 1 FROM operation_logs WHERE module='feedback' AND "targetId"=$1`, [created.body.id])).toHaveLength(0);
    });
    it('gate 1: cross-user access is invisible: nobody else sees the row, and staff routes are unreachable with the owner token', async () => {
      const created = await submit(owner, 'gate1-cross-key01', { type: 'bug', message: 'SENTINEL-OWNER-PRIVATE' }).expect(201);
      const otherList = await as(request(server()).get('/api/feedback/mine?pageSize=50'), other).expect(200);
      expect(JSON.stringify(otherList.body)).not.toContain('SENTINEL-OWNER-PRIVATE');
      // There is no per-id user route: another user's id cannot be probed.
      await as(request(server()).get(`/api/feedback/${created.body.id}`), other).expect(404);
      await as(request(server()).patch(`/api/feedback/${created.body.id}`), other).send({ message: 'edited' }).expect(404);
      await as(request(server()).delete(`/api/feedback/${created.body.id}`), owner).expect(404);
      // Replaying the owner's key as another user creates that user's own row, never exposing the owner's.
      const mine = await submit(other, 'gate1-cross-key01', { type: 'bug', message: 'my own' }).expect(201);
      expect(mine.body.id).not.toBe(created.body.id);
      expect(mine.body.message).toBe('my own');
    });
    it('gate 8: staff PATCH refuses an untrusted Origin; the audit row stores field names only, never the text', async () => {
      const created = await submit(owner, 'gate8-audit-key-1', { type: 'bug', message: 'audit me' }).expect(201);
      await request(server()).patch(`/api/management/feedback/${created.body.id}`).set('Authorization', `Bearer ${staff.token}`).set('Origin', 'https://evil.example')
        .send({ expectedRevision: 0, status: 'closed' }).expect(403);
      await patch(staff, created.body.id, { expectedRevision: 0, reply: 'SENTINEL-REPLY-TEXT', staffNote: 'SENTINEL-NOTE-TEXT' }).expect(200);
      const audit = await rows(`SELECT "userId", "targetType", method, path, metadata FROM operation_logs WHERE module='feedback' AND "targetId"=$1`, [created.body.id]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ userId: staff.id, targetType: 'feedback', method: 'PATCH' });
      expect(JSON.stringify(audit)).not.toMatch(/SENTINEL/);
    });
    it('gate 5: the owner projection never carries staff-only or diagnostic fields; the staff projection never carries the idempotency key', async () => {
      const created = await submit(owner, 'gate5-leak-key-01', { type: 'bug', message: 'leak check', pagePath: '/account', locale: 'en' }).expect(201);
      await patch(staff, created.body.id, { expectedRevision: 0, status: 'resolved', reply: 'visible reply', staffNote: 'SENTINEL-STAFF-ONLY' }).expect(200);
      const forbidden = ['ownerId', 'staffNote', 'handledBy', 'requestKey', 'userAgent', 'pagePath', 'locale', 'revision', 'updatedAt', 'SENTINEL-STAFF-ONLY', owner.token, staff.token];
      const mine = await as(request(server()).get('/api/feedback/mine'), owner).expect(200);
      const created2 = await submit(owner, 'gate5-leak-key-01', { type: 'bug', message: 'leak check', pagePath: '/account', locale: 'en' }).expect(201);
      for (const body of [mine.body, created2.body]) for (const word of forbidden) expect(JSON.stringify(body), word).not.toContain(word);
      expect(Object.keys(mine.body.data[0]).sort()).toEqual(['createdAt', 'id', 'message', 'repliedAt', 'reply', 'status', 'type']);
      for (const response of [await as(request(server()).get('/api/management/feedback'), staff).expect(200), await as(request(server()).get(`/api/management/feedback/${created.body.id}`), staff).expect(200),
        await patch(staff, created.body.id, { expectedRevision: 1, staffNote: 'edited note' }).expect(200)])
        expect(JSON.stringify(response.body)).not.toMatch(/requestKey|gate5-leak-key-01|password|token/i);
      for (const response of [await as(request(server()).get('/api/feedback/mine'), owner), await as(request(server()).get('/api/management/feedback'), staff)])
        expect(response.headers['cache-control']).toContain('no-store');
    });
    it('gate 6: untrusted Origin is refused on submit and nothing is stored', async () => {
      const before = (await rows('SELECT COUNT(*)::int AS n FROM feedback'))[0]!.n;
      await request(server()).post('/api/feedback').set('Authorization', `Bearer ${owner.token}`).set('Origin', 'https://evil.example')
        .set('Idempotency-Key', 'origin-key-0001').send({ type: 'bug', message: 'x' }).expect(403);
      expect((await rows('SELECT COUNT(*)::int AS n FROM feedback'))[0]!.n).toBe(before);
    });
  });

  describe('deletion', () => {
    it('the contributor is idempotent, removes only that owner and leaves nothing readable for them', async () => {
      const user = await member('gdelete'), keep = await member('gkeep');
      await submit(user, 'del-key-00000001', { type: 'bug', message: 'to erase', pagePath: '/x' }).expect(201);
      await submit(keep, 'del-key-00000002', { type: 'bug', message: 'to keep' }).expect(201);
      await database.transaction(tx => feedbackDeletionContributor.erase(tx, user.id));
      await database.transaction(tx => feedbackDeletionContributor.erase(tx, user.id));
      await database.transaction(tx => feedbackDeletionContributor.erase(tx, 'no-such-user'));
      expect(await rows('SELECT 1 FROM feedback WHERE "ownerId"=$1', [user.id])).toHaveLength(0);
      expect(await rows('SELECT 1 FROM feedback WHERE "ownerId"=$1', [keep.id])).toHaveLength(1);
      expect(feedbackDeletionContributor).toMatchObject({ name: 'feedback', order: 50 });
    });
  });
});
