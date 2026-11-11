/**
 * Referral programme (WP 3.5a) test-engineer matrix on PostgreSQL + HTTP: claim rule table (window edges, prior
 * order, disabled code or user, uniform refusal), policy validation and pins, reward idempotency under heavy
 * concurrency, skip reasons, notifier failure, deletion edges and the section-4 gates.
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
import { REFERRAL_POLICIES, REFERRAL_POLICY, readReferralPolicy, type ReferralPolicyValues } from '../src/referrals/referral.policy';
import { REFERRAL_NOTIFIER, REFERRAL_OPTIONS, referralOptionsFromEnvironment, type ReferralRewardNotice } from '../src/referrals/referral.tokens';
import { ReferralsController, ReferralsManagementController } from '../src/referrals/referrals.controller';
import { ReferralsService, REFERRAL_CODE_ALPHABET, generateReferralCode, normalizeReferralCode } from '../src/referrals/referrals.service';
import { ReferralRewards, referralCreditKey } from '../src/referrals/referral-rewards';
import { referralDeletionContributor } from '../src/referrals/referral-deletion';
import { createIsolatedSchema, type IsolatedSchema } from './helpers/phase3-schema';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:4202', DAY = 86_400_000;
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-referral-gates-jwt-secret-32-chars',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt' };
type User = { id: string; token: string };

run('referral programme gates (PostgreSQL + HTTP)', () => {
  let app: INestApplication, iso: IsolatedSchema, database: ApplicationDatabase, policies: PolicyService, referrals: ReferralsService, rewards: ReferralRewards;
  let clock = new Date(), notifierMode: 'ok' | 'throw' = 'ok', seq = 0;
  const notices: ReferralRewardNotice[] = [];
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const q = (sql: string, values: unknown[] = []) => database.transaction(tx => tx.query<Record<string, any>>(sql, values));
  const api = (method: 'get' | 'post' | 'patch', path: string, user: User) => request(app.getHttpServer())[method](`/api${path}`).set('Authorization', `Bearer ${user.token}`).set('Origin', origin);
  const strip = (body: Record<string, unknown>) => { const { timestamp: _t, ...rest } = body; return rest; };

  /** Direct-SQL user (fast, no session). `createdAt` defaults to the injected clock. */
  async function person(label: string, options: { createdAt?: Date; status?: boolean } = {}) {
    const id = `${label}-${++seq}`;
    await q(`INSERT INTO users (id, username, password, name, "typeId", status, "createTime") VALUES ($1, $1, 'x', 'n', 'member', $2, $3)`,
      [id, options.status ?? true, options.createdAt ?? new Date(clock.getTime() - 1000)]);
    return id;
  }
  async function session(username: string, permissions: string[] = []): Promise<User> {
    const email = `${username}@example.invalid`, password = 'SyntheticReferral9!';
    const send = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200);
    for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: login.body.userId, permissionId: permission, grantType: 'grant' } });
    return { id: login.body.userId as string, token: login.body.token as string };
  }
  async function setPolicy(values: Partial<ReferralPolicyValues>) {
    const view = await policies.view('referral') as { revision: number };
    await policies.save('system', 'referral', { expectedRevision: view.revision, values });
  }
  const defaults: ReferralPolicyValues = { enabled: true, referrerCredits: 100, refereeCredits: 50, rewardValidDays: 0, claimWindowDays: 7, rewardDelayDays: 7, maxRewardsPerReferrer: 0 };
  const reset = (extra: Partial<ReferralPolicyValues> = {}) => setPolicy({ ...defaults, ...extra });
  async function order(ownerId: string, fulfilledAt: Date | null, extra: { state?: string; paymentId?: string } = {}) {
    const id = `ord-${randomUUID()}`;
    await q(`INSERT INTO billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey", "creationState", "captureState",
      state, "paymentId", "paymentKind", "fulfilledAt") VALUES ($1, $2, 'pack', 'fake', 'default', '{}'::jsonb, '/s', '/c', $1 || ':c', $1 || ':k', 'created', 'captured', $3, $4, 'payment-intent', $5)`,
    [id, ownerId, extra.state ?? 'paid', extra.paymentId ?? `${id}:pay`, fulfilledAt]);
    return id;
  }
  const balance = async (userId: string) => Number((await q('SELECT COALESCE(SUM(balance),0)::int AS b FROM credit_account WHERE "userId" = $1', [userId])).rows[0].b);
  const claim = (userId: string, code: unknown) => referrals.claim(userId, { code });
  const codeOf = async (userId: string) => (await referrals.ensureCode(userId)).code;
  /** A referrer with a code and a referee bound to it. */
  async function pair(bound = true, bindAt = clock) {
    const referrer = await person('rr'), referee = await person('re');
    const code = await codeOf(referrer);
    if (bound) await q(`INSERT INTO referral_bindings ("refereeId", "referrerId", code, "boundAt") VALUES ($1, $2, $3, $4)`, [referee, referrer, code, bindAt]);
    return { referrer, referee, code };
  }

  beforeAll(async () => {
    iso = await createIsolatedSchema('zucker_refm', databaseUrl!);
    database = new ApplicationDatabase(iso.url.href);
    process.env.ACCOUNT_ORIGINS = origin;
    const limits = { points: 5000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits, 'referral-claim': limits } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...REFERRAL_POLICIES] }), AccountModule],
    controllers: [ReferralsController, ReferralsManagementController],
    providers: [ReferralsService, ReferralRewards,
      { provide: REFERRAL_OPTIONS, useValue: { webOrigin: origin, now: () => clock } },
      { provide: REFERRAL_NOTIFIER, useValue: { notifyReward: async (_tx: unknown, notice: ReferralRewardNotice) => { if (notifierMode === 'throw') throw new Error('notifier down'); notices.push(notice); } } },
      { provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    policies = app.get(PolicyService); referrals = app.get(ReferralsService); rewards = app.get(ReferralRewards);
    for (const id of ['referrals:query', 'referrals:update']) await database.model('permissions').create({ data: { id, name: id } });
  }, 60_000);
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { await iso?.drop(); } });

  describe('code format', () => {
    it('generated codes use the unambiguous alphabet, are 8 long, and normalisation is strict', () => {
      for (let index = 0; index < 300; index += 1) expect(generateReferralCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      expect(REFERRAL_CODE_ALPHABET).not.toMatch(/[IO01]/);
      expect(normalizeReferralCode(' abcd2345 ')).toBe('ABCD2345');
      for (const bad of ['ABC12', 'A'.repeat(17), 'AB CD234', 'ABCD-234', '<script>', '', 'ä'.repeat(8), 12345678, null, undefined, ['ABCD2345'], { code: 'ABCD2345' }, 'A'.repeat(65)])
        expect(normalizeReferralCode(bad), String(bad)).toBeNull();
    });
    it('10 concurrent first reads give the user one stable code and one row', async () => {
      const id = await person('fresh');
      const codes = await Promise.all(Array.from({ length: 10 }, () => referrals.ensureCode(id)));
      expect(new Set(codes.map(entry => entry.code)).size).toBe(1);
      expect((await q('SELECT COUNT(*)::int AS n FROM referral_codes WHERE "userId"=$1', [id])).rows[0].n).toBe(1);
    });
  });

  describe('policy', () => {
    it('refuses out-of-range and cross-field-invalid values', async () => {
      const save = async (values: Record<string, unknown>) => {
        const view = await policies.view('referral') as { revision: number };
        return policies.save('system', 'referral', { expectedRevision: view.revision, values } as never);
      };
      for (const values of [{ enabled: true }, { enabled: true, referrerCredits: 0, refereeCredits: 0 }, { referrerCredits: -1 }, { referrerCredits: 1_000_001 }, { referrerCredits: 1.5 },
        { claimWindowDays: 0 }, { claimWindowDays: 366 }, { rewardDelayDays: -1 }, { rewardDelayDays: 366 }, { rewardValidDays: 3651 }, { maxRewardsPerReferrer: 100_001 }, { enabled: 'true' }, { bogus: 1 }])
        await expect(save(values), JSON.stringify(values)).rejects.toBeDefined();
      await expect(save({ enabled: true, referrerCredits: 1 })).resolves.toBeDefined();
      await expect(save({ enabled: true, refereeCredits: 1 })).resolves.toBeDefined();
      await expect(save({ enabled: false })).resolves.toBeDefined();
      await reset();
    });
    it('only `enabled` is public: amounts, delays and caps never reach /site/public/config', async () => {
      await reset({ referrerCredits: 777, refereeCredits: 555, maxRewardsPerReferrer: 9 });
      const config = await request(app.getHttpServer()).get('/api/site/public/config').expect(200);
      const text = JSON.stringify(config.body);
      expect(text).toContain('referral');
      for (const word of ['777', '555', 'referrerCredits', 'refereeCredits', 'maxRewardsPerReferrer', 'rewardDelayDays', 'claimWindowDays']) expect(text, word).not.toContain(word);
      await reset();
    });
    it('environment pins override saved values and an invalid pin fails at construction; defaults leave the programme off', async () => {
      const pinned = new PolicyService(database, [REFERRAL_POLICY], { POLICY_REFERRAL_ENABLED: 'false', POLICY_REFERRAL_REFERRER_CREDITS: '5' });
      expect(await pinned.get(REFERRAL_POLICY)).toMatchObject({ enabled: false, referrerCredits: 5 });
      expect((await pinned.view('referral')).fields.filter(field => field.pinnedByEnvironment).map(field => field.key).sort()).toEqual(['enabled', 'referrerCredits']);
      const offByPin = new ReferralsService(database, { webOrigin: origin, now: () => clock }, pinned);
      expect(await offByPin.availability()).toEqual({ enabled: false, reason: 'disabled' });
      expect(() => new PolicyService(database, [REFERRAL_POLICY], { POLICY_REFERRAL_CLAIM_WINDOW_DAYS: 'week' })).toThrow(/not a valid/);
      // Defaults (nothing saved, nothing pinned) and a composition without the policy registered: programme off, 7-day window and delay.
      const defaultsOnly = { enabled: false, referrerCredits: 0, refereeCredits: 0, rewardValidDays: 0, claimWindowDays: 7, rewardDelayDays: 7, maxRewardsPerReferrer: 0 };
      expect(Object.fromEntries(REFERRAL_POLICY.fields.map(field => [field.key, field.default]))).toEqual(defaultsOnly);
      expect(await readReferralPolicy(undefined)).toEqual(defaultsOnly);
      expect(referralOptionsFromEnvironment({ WEB_URL: 'javascript:alert(1)' }).webOrigin).toBeNull();
      expect(referralOptionsFromEnvironment({ WEB_URL: 'https://app.example.test/path?x=1' }).webOrigin).toBe('https://app.example.test');
      expect(referralOptionsFromEnvironment({}).webOrigin).toBeNull();
    });
  });

  describe('claim rule table', () => {
    it('window edges are inclusive: exactly claimWindowDays old binds, one millisecond older does not; the window follows the policy', async () => {
      await reset(); clock = new Date();
      const referrer = await person('rr'), code = await codeOf(referrer);
      const exact = await person('edge', { createdAt: new Date(clock.getTime() - 7 * DAY) });
      const late = await person('late', { createdAt: new Date(clock.getTime() - 7 * DAY - 1) });
      await expect(claim(exact, code)).resolves.toEqual({ bound: true });
      await expect(claim(late, code)).rejects.toMatchObject({ status: 400 });
      await reset({ claimWindowDays: 30 });
      await expect(claim(late, code)).resolves.toEqual({ bound: true });
      await reset({ claimWindowDays: 1 });
      const twoDays = await person('two', { createdAt: new Date(clock.getTime() - 2 * DAY) });
      await expect(claim(twoDays, code)).rejects.toMatchObject({ status: 400 });
      const future = await person('future', { createdAt: new Date(clock.getTime() + DAY) });
      await expect(claim(future, code)).resolves.toEqual({ bound: true });
      await reset();
    });

    it('an existing customer cannot claim (any fulfilled order), an unfulfilled order does not block', async () => {
      await reset(); clock = new Date();
      const referrer = await person('rr'), code = await codeOf(referrer);
      const customer = await person('cust'), shopper = await person('shop');
      await order(customer, new Date(clock.getTime() - DAY));
      await order(shopper, null, { state: 'created' });
      await expect(claim(customer, code)).rejects.toMatchObject({ status: 400 });
      await expect(claim(shopper, code)).resolves.toEqual({ bound: true });
    });

    it('disabled code, deactivated code owner, deactivated claimer, unknown code and the off switch are all refused', async () => {
      await reset(); clock = new Date();
      const live = await person('live'), liveCode = await codeOf(live);
      const disabledOwner = await person('dis'), disabledCode = await codeOf(disabledOwner);
      await q('UPDATE referral_codes SET "disabledAt"=now() WHERE "userId"=$1', [disabledOwner]);
      const banned = await person('ban', { status: false }), bannedCode = await codeOf(banned);
      const claimer = await person('cl'), gone = await person('gone', { status: false });
      await expect(claim(claimer, disabledCode)).rejects.toMatchObject({ status: 400 });
      await expect(claim(claimer, bannedCode)).rejects.toMatchObject({ status: 400 });
      await expect(claim(claimer, 'ZZZZZZZZ')).rejects.toMatchObject({ status: 400 });
      await expect(claim(gone, liveCode)).rejects.toMatchObject({ status: 400 });
      await expect(claim('no-such-user', liveCode)).rejects.toMatchObject({ status: 400 });
      await setPolicy({ enabled: false });
      await expect(claim(claimer, liveCode)).rejects.toMatchObject({ status: 400 });
      await reset();
      await expect(claim(claimer, liveCode.toLowerCase())).resolves.toEqual({ bound: true });
      expect((await q('SELECT COUNT(*)::int AS n FROM referral_bindings WHERE "refereeId" = ANY($1)', [[claimer, gone, 'no-such-user']])).rows[0].n).toBe(1);
    });

    it('every refusal is the same 400 body (no enumeration of codes, accounts or rules)', async () => {
      await reset(); clock = new Date();
      const referrer = await person('rr'), code = await codeOf(referrer);
      const claimer = await person('cl'), old = await person('old', { createdAt: new Date(clock.getTime() - 30 * DAY) });
      const disabled = await person('dis'), disabledCode = await codeOf(disabled);
      await q('UPDATE referral_codes SET "disabledAt"=now() WHERE "userId"=$1', [disabled]);
      const causes: Array<[string, string, unknown]> = [['self', referrer, { code }], ['unknown code', claimer, { code: 'ZZZZZZZZ' }], ['malformed', claimer, { code: '<x>' }],
        ['extra key', claimer, { code, extra: 1 }], ['no code', claimer, {}], ['window', old, { code }], ['disabled', claimer, { code: disabledCode }], ['array body', claimer, [code]], ['null body', claimer, null]];
      const bodies = [];
      for (const [label, user, body] of causes) {
        const error = await referrals.claim(user, body).then(() => null, (failure: unknown) => failure as { status: number; response: unknown });
        expect(error?.status, label).toBe(400);
        bodies.push(JSON.stringify(error?.response));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toContain('REFERRAL_NOT_APPLICABLE');
    });

    it('a bound referee can replay the same code but never switch to another; self and mutual referral are refused', async () => {
      await reset(); clock = new Date();
      const first = await person('rr'), second = await person('rr'), referee = await person('re');
      const code1 = await codeOf(first), code2 = await codeOf(second);
      await claim(referee, code1);
      await expect(claim(referee, code1)).resolves.toEqual({ bound: true });
      await expect(claim(referee, code2)).rejects.toMatchObject({ status: 400 });
      expect((await q('SELECT "referrerId" FROM referral_bindings WHERE "refereeId"=$1', [referee])).rows).toEqual([{ referrerId: first }]);
      await expect(claim(first, code1)).rejects.toMatchObject({ status: 400 });
      const refereeCode = await codeOf(referee);
      await expect(claim(first, refereeCode)).rejects.toMatchObject({ status: 400 }); // mutual: the code owner was referred by the claimer
    });

    it('10 concurrent claims of two different codes by one referee bind exactly one referrer', async () => {
      await reset(); clock = new Date();
      const a = await person('rr'), b = await person('rr'), referee = await person('re');
      const codes = [await codeOf(a), await codeOf(b)];
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => claim(referee, codes[index % 2])));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
      const rows = (await q('SELECT "referrerId", code FROM referral_bindings WHERE "refereeId"=$1', [referee])).rows;
      expect(rows).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected').every(result => (result as PromiseRejectedResult).reason.status === 400)).toBe(true);
    });

    it('database invariants: no self binding, no malformed code, no negative or inconsistent reward row', async () => {
      const { referrer, referee } = await pair();
      await expect(q(`INSERT INTO referral_bindings ("refereeId", "referrerId", code) VALUES ($1, $1, 'AAAAAAAA')`, [referrer])).rejects.toThrow();
      await expect(q(`INSERT INTO referral_codes ("userId", code) VALUES ($1, 'abc')`, [await person('bad')])).rejects.toThrow();
      await expect(q(`INSERT INTO referral_rewards ("refereeId", "referrerId", "orderId", "referrerCredits", "refereeCredits", status) VALUES ($1, $2, 'o-skip', 5, 0, 'skipped')`, [referee, referrer])).rejects.toThrow();
      await expect(q(`INSERT INTO referral_rewards ("refereeId", "referrerId", "orderId", "referrerCredits", "refereeCredits", status) VALUES ($1, $2, 'o-neg', -1, 0, 'granted')`, [referee, referrer])).rejects.toThrow();
    });

    it('the database refuses a mutual binding (WP 3.5a report: "self & mutual referral refused (DB too)")', async () => {
      const { referrer, referee } = await pair();
      await expect(q(`INSERT INTO referral_bindings ("refereeId", "referrerId", code) VALUES ($1, $2, 'MUTUAL22')`, [referrer, referee]), 'mutual binding accepted by the database').rejects.toThrow();
    });
  });

  describe('rewards', () => {
    it('10 racing scanners plus direct calls grant once: one reward row, two ledger receipts, balances move once, replay changes nothing', async () => {
      await reset(); clock = new Date(); notices.length = 0;
      const { referrer, referee } = await pair(true, new Date(clock.getTime() - 9 * DAY));
      const orderId = await order(referee, new Date(clock.getTime() - 8 * DAY));
      const before = { referrer: await balance(referrer), referee: await balance(referee) };
      const scans = await Promise.all([...Array(10)].map(() => rewards.processDue(clock)));
      const direct = await Promise.all([...Array(4)].map(() => rewards.rewardReferee(referee, defaults, clock)));
      expect(scans.flat().filter(outcome => outcome.status === 'granted')).toHaveLength(1);
      expect(direct.filter(outcome => outcome.status === 'granted')).toHaveLength(0);
      expect(direct.every(outcome => outcome.status === 'none')).toBe(true);
      expect((await q('SELECT COUNT(*)::int AS n FROM referral_rewards WHERE "refereeId"=$1', [referee])).rows[0].n).toBe(1);
      expect((await q(`SELECT COUNT(*)::int AS n FROM credit_operation_receipts WHERE "idempotencyKey" = ANY($1)`, [[referralCreditKey(orderId, 'referrer'), referralCreditKey(orderId, 'referee')]])).rows[0].n).toBe(2);
      expect(await balance(referrer) - before.referrer).toBe(100);
      expect(await balance(referee) - before.referee).toBe(50);
      expect(notices.map(notice => [notice.userId, notice.credits, notice.role, notice.rewardId, notice.orderId]).sort()).toEqual([
        [referee, 50, 'referee', `referral:${orderId}:referee`, orderId], [referrer, 100, 'referrer', `referral:${orderId}:referrer`, orderId]].sort());
      expect(await rewards.processDue(clock)).toEqual([]);
      expect(await balance(referrer) - before.referrer).toBe(100);
    });

    it('delay edge: due when the order is exactly rewardDelayDays old, not due one millisecond sooner; the programme off decides nothing', async () => {
      await reset(); clock = new Date();
      const { referee } = await pair(true, new Date(clock.getTime() - 20 * DAY));
      await order(referee, new Date(clock.getTime() - 7 * DAY + 1));
      expect(await rewards.processDue(clock)).toEqual([]);
      expect(await rewards.rewardReferee(referee, defaults, clock)).toEqual({ status: 'none', reason: 'not-due' });
      await setPolicy({ enabled: false });
      expect(await rewards.processDue(new Date(clock.getTime() + 30 * DAY))).toEqual([]);
      expect((await q('SELECT 1 FROM referral_rewards WHERE "refereeId"=$1', [referee])).rows).toHaveLength(0);
      await reset();
      expect(await rewards.processDue(new Date(clock.getTime() + 1))).toMatchObject([{ status: 'granted' }]);
    });

    it('only the earliest fulfilled order counts; later orders and later policy changes never alter the frozen row', async () => {
      await reset({ referrerCredits: 11, refereeCredits: 0, rewardValidDays: 30 }); clock = new Date();
      const { referrer, referee } = await pair(true, new Date(clock.getTime() - 30 * DAY));
      const first = await order(referee, new Date(clock.getTime() - 10 * DAY)); await order(referee, new Date(clock.getTime() - 9 * DAY));
      const outcome = await rewards.rewardReferee(referee, (await policies.get(REFERRAL_POLICY)) as ReferralPolicyValues, clock);
      expect(outcome).toEqual({ status: 'granted', orderId: first, referrerCredits: 11, refereeCredits: 0 });
      await reset({ referrerCredits: 999 });
      expect((await q('SELECT "orderId", "referrerCredits", "refereeCredits", status FROM referral_rewards WHERE "refereeId"=$1', [referee])).rows).toEqual([
        { orderId: first, referrerCredits: 11, refereeCredits: 0, status: 'granted' }]);
      const lot = (await q(`SELECT "expiresAt", amount FROM credit_lots WHERE "userId"=$1 AND source='referral'`, [referrer])).rows;
      expect(lot).toHaveLength(1);
      expect(lot[0].amount).toBe(11);
      expect(Math.abs(new Date(lot[0].expiresAt).getTime() - (clock.getTime() + 30 * DAY))).toBeLessThan(2000);
      // A zero amount is skipped silently: the referee gets no credits and no notification.
      expect(await q('SELECT 1 FROM credit_lots WHERE "userId"=$1 AND source=\'referral\'', [referee])).toMatchObject({ rows: [] });
      await reset();
    });

    it.each([
      ['prior order (fulfilled before the binding)', 'prior-order', async (referee: string, clockNow: Date) => { await order(referee, new Date(clockNow.getTime() - 15 * DAY)); }, 1],
      ['order not in state paid', 'refunded', async (referee: string, clockNow: Date) => { await order(referee, new Date(clockNow.getTime() - 9 * DAY), { state: 'refunded' }); }, 0],
      ['cash refund on the target', 'refunded', async (referee: string, clockNow: Date) => {
        const id = await order(referee, new Date(clockNow.getTime() - 9 * DAY)); await refundTarget(referee, id, { refundedMinor: '100' }); }, 0],
      ['provider-pending refund', 'refunded', async (referee: string, clockNow: Date) => {
        const id = await order(referee, new Date(clockNow.getTime() - 9 * DAY)); await refundTarget(referee, id, { providerPendingMinor: '100' }); }, 0],
      ['attention flag on the target', 'refunded', async (referee: string, clockNow: Date) => {
        const id = await order(referee, new Date(clockNow.getTime() - 9 * DAY)); await refundTarget(referee, id, { attention: true }); }, 0],
      ['unmatched provider refund event naming the payment', 'refunded', async (referee: string, clockNow: Date) => {
        const id = await order(referee, new Date(clockNow.getTime() - 9 * DAY), { paymentId: `pay-${randomUUID()}` });
        const payment = (await q('SELECT "paymentId" FROM billing_orders WHERE id=$1', [id])).rows[0].paymentId;
        await q(`INSERT INTO billing_refund_events ("providerId", "accountScope", "eventId", "sourceKind", "sourceId", evidence) VALUES ('fake', 'default', $1, 'payment-intent', $2, '{}'::jsonb)`, [`evt-${randomUUID()}`, payment]); }, 0],
    ] as const)('skips for good: %s', async (_label, reason, arrange, bindDaysAgo) => {
      await reset(); clock = new Date();
      const { referrer, referee } = await pair(true, new Date(clock.getTime() - (bindDaysAgo ? 10 : 20) * DAY));
      await arrange(referee, clock);
      const before = await balance(referrer);
      const outcomes = await rewards.processDue(clock);
      expect(outcomes).toMatchObject([{ status: 'skipped', reason }]);
      expect((await q('SELECT status, "skipReason", "referrerCredits", "refereeCredits" FROM referral_rewards WHERE "refereeId"=$1', [referee])).rows).toEqual([{ status: 'skipped', skipReason: reason, referrerCredits: 0, refereeCredits: 0 }]);
      expect(await balance(referrer)).toBe(before);
      expect(await rewards.processDue(new Date(clock.getTime() + 60 * DAY))).toEqual([]); // final
    });

    async function refundTarget(ownerId: string, orderId: string, columns: { refundedMinor?: string; providerPendingMinor?: string; attention?: boolean }) {
      await q(`INSERT INTO billing_refund_payments (id, "ownerId", "orderId", "providerId", "accountScope", "paymentKind", "paymentId", "sourceKind", "sourceId", title, "paidMoney", "paidMinor",
        "minorScale", "totalCredits", "refundedMinor", "providerPendingMinor", attention, "observedAt") VALUES ($1, $2, $3, 'fake', 'default', 'payment-intent', $1 || ':pay', 'payment-intent', $1 || ':pay',
        'Pack', '{"amount":"10.00","currency":"USD"}'::jsonb, '1000', 2, 100, $4, $5, $6, now())`,
      [`rt-${randomUUID()}`, ownerId, orderId, columns.refundedMinor ?? '0', columns.providerPendingMinor ?? null, columns.attention ?? false]);
    }

    it('a deactivated or disabled referrer / deactivated referee skips; the rewards stay final when the cause goes away', async () => {
      await reset(); clock = new Date();
      const disabled = await pair(true, new Date(clock.getTime() - 20 * DAY)); await order(disabled.referee, new Date(clock.getTime() - 9 * DAY));
      await q('UPDATE referral_codes SET "disabledAt"=now() WHERE "userId"=$1', [disabled.referrer]);
      const banned = await pair(true, new Date(clock.getTime() - 20 * DAY)); await order(banned.referee, new Date(clock.getTime() - 9 * DAY));
      await q('UPDATE users SET status=false WHERE id=$1', [banned.referrer]);
      const gone = await pair(true, new Date(clock.getTime() - 20 * DAY)); await order(gone.referee, new Date(clock.getTime() - 9 * DAY));
      await q('UPDATE users SET status=false WHERE id=$1', [gone.referee]);
      const outcomes = await rewards.processDue(clock);
      expect(Object.fromEntries(outcomes.map(outcome => [(outcome as { reason: string }).reason, outcome.status]))).toEqual({ 'code-disabled': 'skipped', 'referrer-unavailable': 'skipped', 'referee-unavailable': 'skipped' });
      await q('UPDATE referral_codes SET "disabledAt"=NULL WHERE "userId"=$1', [disabled.referrer]);
      expect(await rewards.processDue(clock)).toEqual([]);
    });

    it('maxRewardsPerReferrer holds under 12 racing scanners: exactly the cap is granted, the rest are cap-reached', async () => {
      await reset({ maxRewardsPerReferrer: 2 }); clock = new Date();
      const referrer = await person('rr'), code = await codeOf(referrer), referees: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const referee = await person('re'); referees.push(referee);
        await q(`INSERT INTO referral_bindings ("refereeId", "referrerId", code, "boundAt") VALUES ($1, $2, $3, $4)`, [referee, referrer, code, new Date(clock.getTime() - 20 * DAY)]);
        await order(referee, new Date(clock.getTime() - 9 * DAY));
      }
      const before = await balance(referrer);
      await Promise.all([...Array(12)].map(() => rewards.processDue(clock)));
      const decided = (await q('SELECT status, "skipReason" FROM referral_rewards WHERE "referrerId"=$1', [referrer])).rows;
      expect(decided.filter(row => row.status === 'granted')).toHaveLength(2);
      expect(decided.filter(row => row.skipReason === 'cap-reached')).toHaveLength(3);
      expect(await balance(referrer) - before).toBe(200);
      await reset();
    });

    it('a failing notifier never undoes the reward: credits granted, the reward row kept, the failure not leaked', async () => {
      await reset(); clock = new Date(); notices.length = 0;
      const { referrer, referee } = await pair(true, new Date(clock.getTime() - 20 * DAY));
      await order(referee, new Date(clock.getTime() - 9 * DAY));
      const before = await balance(referrer);
      notifierMode = 'throw';
      try { expect(await rewards.processDue(clock)).toMatchObject([{ status: 'granted' }]); } finally { notifierMode = 'ok'; }
      expect(await balance(referrer) - before).toBe(100);
      expect(notices).toEqual([]);
      expect((await q('SELECT status FROM referral_rewards WHERE "refereeId"=$1', [referee])).rows).toEqual([{ status: 'granted' }]);
    });

    it('a pending reward waits while the programme is off or an affiliate tool is on, and is decided afterwards', async () => {
      await reset(); clock = new Date();
      const { referee } = await pair(true, new Date(clock.getTime() - 20 * DAY));
      await order(referee, new Date(clock.getTime() - 9 * DAY));
      const settings = (referrals as unknown as { settings?: { publicIntegrations: () => Promise<unknown> } }).settings;
      if (settings) {
        const original = settings.publicIntegrations.bind(settings);
        settings.publicIntegrations = async () => ({ connections: { enabled: true, promoteKit: { enabled: true } } });
        try { expect(await rewards.processDue(clock)).toEqual([]); expect(await referrals.availability()).toEqual({ enabled: false, reason: 'external-affiliate' }); }
        finally { settings.publicIntegrations = original; }
        settings.publicIntegrations = async () => { throw new Error('unreadable'); };
        try { expect(await referrals.availability()).toEqual({ enabled: false, reason: 'unavailable' }); expect(await rewards.processDue(clock)).toEqual([]); }
        finally { settings.publicIntegrations = original; }
      }
      expect(await rewards.processDue(clock)).toMatchObject([{ status: 'granted' }]);
    });
  });

  describe('deletion', () => {
    it('referee erase drops the binding and code but keeps decided reward rows; referrer erase drops the code so a pending reward is skipped; both are idempotent', async () => {
      await reset(); clock = new Date();
      const granted = await pair(true, new Date(clock.getTime() - 20 * DAY)); await order(granted.referee, new Date(clock.getTime() - 9 * DAY));
      await rewards.processDue(clock);
      await codeOf(granted.referee);
      for (let run_ = 0; run_ < 2; run_ += 1) await database.transaction(tx => referralDeletionContributor.erase(tx, granted.referee));
      expect((await q('SELECT 1 FROM referral_bindings WHERE "refereeId"=$1', [granted.referee])).rows).toHaveLength(0);
      expect((await q('SELECT 1 FROM referral_codes WHERE "userId"=$1', [granted.referee])).rows).toHaveLength(0);
      expect((await q('SELECT status FROM referral_rewards WHERE "refereeId"=$1', [granted.referee])).rows).toEqual([{ status: 'granted' }]);
      expect((await q('SELECT 1 FROM referral_codes WHERE "userId"=$1', [granted.referrer])).rows).toHaveLength(1);

      const pending = await pair(true, new Date(clock.getTime() - 20 * DAY)); await order(pending.referee, new Date(clock.getTime() - 9 * DAY));
      await database.transaction(tx => referralDeletionContributor.erase(tx, pending.referrer));
      await database.transaction(tx => referralDeletionContributor.erase(tx, 'never-existed'));
      expect((await q('SELECT 1 FROM referral_bindings WHERE "refereeId"=$1', [pending.referee])).rows).toHaveLength(1);
      expect(await rewards.processDue(clock)).toMatchObject([{ status: 'skipped', reason: 'code-disabled' }]);
      expect(referralDeletionContributor).toMatchObject({ name: 'referrals', order: 10 });
    });
    it('an erased referrer\'s old code no longer binds anyone', async () => {
      await reset(); clock = new Date();
      const referrer = await person('rr'), code = await codeOf(referrer), claimer = await person('cl');
      await database.transaction(tx => referralDeletionContributor.erase(tx, referrer));
      await expect(claim(claimer, code)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('security gates (HTTP)', () => {
    let owner: User, other: User, admin: User, viewer: User, nobody: User;
    beforeAll(async () => {
      await reset();
      owner = await session('rgowner'); other = await session('rgother'); nobody = await session('rgnobody');
      admin = await session('rgadmin', ['referrals:query', 'referrals:update']); viewer = await session('rgviewer', ['referrals:query']);
    }, 60_000);

    it('gate 1: anonymous is 401 everywhere; users without permissions are 403 on management routes', async () => {
      await request(app.getHttpServer()).get('/api/referrals/me').expect(401);
      await request(app.getHttpServer()).post('/api/referrals/claim').set('Origin', origin).send({ code: 'ABCDEFGH' }).expect(401);
      await request(app.getHttpServer()).get('/api/management/referrals').expect(401);
      await request(app.getHttpServer()).patch(`/api/management/referrals/codes/${owner.id}`).set('Origin', origin).send({ disabled: true }).expect(401);
      for (const user of [nobody, owner]) {
        await api('get', '/management/referrals', user).expect(403);
        await api('patch', `/management/referrals/codes/${other.id}`, user).send({ disabled: true }).expect(403);
      }
    });

    it('gate 1: viewer (referrals:query) lists but gets 403 on the code switch, with no change and no audit row', async () => {
      await codeOf(other.id);
      await api('get', '/management/referrals', viewer).expect(200);
      await api('patch', `/management/referrals/codes/${other.id}`, viewer).send({ disabled: true }).expect(403);
      expect((await q('SELECT "disabledAt" FROM referral_codes WHERE "userId"=$1', [other.id])).rows[0].disabledAt).toBeNull();
      expect((await q(`SELECT 1 FROM operation_logs WHERE module='referrals' AND "targetId"=$1`, [other.id])).rows).toHaveLength(0);
    });

    it('gate 8: the code switch needs a trusted Origin, validates its body, is audited with field names only, and works both ways', async () => {
      await request(app.getHttpServer()).patch(`/api/management/referrals/codes/${other.id}`).set('Authorization', `Bearer ${admin.token}`).set('Origin', 'https://evil.example').send({ disabled: true }).expect(403);
      await request(app.getHttpServer()).patch(`/api/management/referrals/codes/${other.id}`).set('Authorization', `Bearer ${admin.token}`).send({ disabled: true }).expect(403);
      for (const body of [{}, { disabled: 'true' }, { disabled: 1 }, { disabled: true, userId: owner.id }, [true], null])
        expect((await api('patch', `/management/referrals/codes/${other.id}`, admin).send(body as never)).status, JSON.stringify(body)).toBe(400);
      for (const id of ['no-such-user', "x' OR '1'='1", '..%2F..', 'a'.repeat(192)])
        expect((await api('patch', `/management/referrals/codes/${encodeURIComponent(id)}`, admin).send({ disabled: true })).status, id).toBe(404);
      const off = await api('patch', `/management/referrals/codes/${other.id}`, admin).send({ disabled: true }).expect(200);
      expect(off.body).toMatchObject({ userId: other.id, disabled: true });
      await api('patch', `/management/referrals/codes/${other.id}`, admin).send({ disabled: true }).expect(200); // idempotent
      expect((await api('get', '/referrals/me', other).expect(200)).body).toMatchObject({ codeActive: false, link: null });
      await api('patch', `/management/referrals/codes/${other.id}`, admin).send({ disabled: false }).expect(200);
      expect((await api('get', '/referrals/me', other).expect(200)).body).toMatchObject({ codeActive: true });
      const audit = (await q(`SELECT "userId", metadata, action FROM operation_logs WHERE module='referrals' AND "targetId"=$1 ORDER BY "createdAt", action`, [other.id])).rows;
      expect(audit.length).toBeGreaterThanOrEqual(3);
      expect(audit.every(entry => entry.userId === admin.id && Object.keys(entry.metadata).join() === 'disabled')).toBe(true);
    });

    it('disabling a user who never had a code allocates one already disabled, so they cannot obtain a fresh one', async () => {
      const fresh = await person('nocode');
      expect((await q('SELECT 1 FROM referral_codes WHERE "userId"=$1', [fresh])).rows).toHaveLength(0);
      await api('patch', `/management/referrals/codes/${fresh}`, admin).send({ disabled: true }).expect(200);
      expect((await q('SELECT "disabledAt" FROM referral_codes WHERE "userId"=$1', [fresh])).rows[0].disabledAt).not.toBeNull();
      expect((await referrals.ensureCode(fresh)).disabledAt).not.toBeNull();
    });

    it('management list: filters are validated, bounded and parameterised', async () => {
      for (const query of ['?foo=1', '?status=bogus', '?page=0', '?pageSize=101', '?code=<x>', "?referrerId=x'%20OR%201=1", '?page=1.5'])
        expect((await api('get', `/management/referrals${query}`, viewer)).status, query).toBe(400);
      const hostile = await api('get', `/management/referrals?refereeId=${encodeURIComponent('a-b_c')}`, viewer).expect(200);
      expect(hostile.body.total).toBe(0);
      const all = await api('get', '/management/referrals?pageSize=100', viewer).expect(200);
      expect(all.body.total).toBeGreaterThan(5);
      expect(Object.keys(all.body.data[0]).sort()).toEqual(['boundAt', 'code', 'codeDisabled', 'orderId', 'refereeCredits', 'refereeId', 'referrerCredits', 'referrerId', 'rewardStatus', 'rewardedAt', 'skipReason']);
      expect(JSON.stringify(all.body)).not.toMatch(/password|token|email|username/i);
      for (const status of ['pending', 'granted', 'skipped']) {
        const filtered = await api('get', `/management/referrals?status=${status}&pageSize=100`, viewer).expect(200);
        expect(filtered.body.data.every((row: { rewardStatus: string }) => row.rewardStatus === status), status).toBe(true);
      }
    });

    it('gate 5: /referrals/me never reveals referee identity, other users\' data or amounts; claim needs a trusted Origin and sets no-store', async () => {
      await reset({ referrerCredits: 321, refereeCredits: 123 });
      const referrerUser = await session('rgref'), guest = await session('rgguest');
      const mine = (await api('get', '/referrals/me', referrerUser).expect(200)).body;
      await api('post', '/referrals/claim', guest).send({ code: mine.code }).expect(200);
      const after = await api('get', '/referrals/me', referrerUser).expect(200);
      expect(after.headers['cache-control']).toContain('no-store');
      expect(after.body.stats).toEqual({ invited: 1, rewarded: 0, creditsEarned: 0 });
      expect(after.body.recent).toEqual([{ boundAt: expect.any(String), status: 'pending' }]);
      for (const word of [guest.id, 'rgguest', 'example.invalid', guest.token, 'password', '321', '123']) expect(JSON.stringify(after.body), word).not.toContain(word);
      expect(JSON.stringify((await api('get', '/referrals/me', guest).expect(200)).body)).not.toContain(referrerUser.id);
      await request(app.getHttpServer()).post('/api/referrals/claim').set('Authorization', `Bearer ${nobody.token}`).set('Origin', 'https://evil.example').send({ code: mine.code }).expect(403);
      await request(app.getHttpServer()).post('/api/referrals/claim').set('Authorization', `Bearer ${nobody.token}`).send({ code: mine.code }).expect(403);
      expect((await q('SELECT 1 FROM referral_bindings WHERE "refereeId"=$1', [nobody.id])).rows).toHaveLength(0);
      await reset();
    });

    it('gate 6: identity comes from the session; a body naming another referee or referrer is refused', async () => {
      const refereeUser = await session('rgbody'), target = await session('rgvictim'), rr = await session('rgrr');
      const code = (await api('get', '/referrals/me', rr).expect(200)).body.code;
      for (const body of [{ code, refereeId: target.id }, { code, userId: target.id }, { code, referrerId: target.id }])
        await api('post', '/referrals/claim', refereeUser).send(body).expect(400);
      await api('post', '/referrals/claim', refereeUser).send({ code }).expect(200);
      expect((await q('SELECT "refereeId" FROM referral_bindings WHERE "referrerId"=$1', [rr.id])).rows).toEqual([{ refereeId: refereeUser.id }]);
      expect((await q('SELECT 1 FROM referral_bindings WHERE "refereeId"=$1', [target.id])).rows).toHaveLength(0);
    });

    it('the programme off answers `enabled:false` without creating a code, and claims are refused', async () => {
      await setPolicy({ enabled: false });
      try {
        const fresh = await session('rgoff');
        expect((await api('get', '/referrals/me', fresh).expect(200)).body).toEqual({ enabled: false, reason: 'disabled' });
        expect((await q('SELECT 1 FROM referral_codes WHERE "userId"=$1', [fresh.id])).rows).toHaveLength(0);
        await api('post', '/referrals/claim', fresh).send({ code: 'ABCDEFGH' }).expect(400);
      } finally { await reset(); }
    });
  });
});
