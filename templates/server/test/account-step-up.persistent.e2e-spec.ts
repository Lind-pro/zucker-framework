import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { BcryptEncoder, GoogleIdTokenVerifier, PermissionsGuard, ZuckerAuthModule, generateTotpCode, type VerifiedOAuthIdentity } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, AccountService, type AccountMailer } from '../src/accounts/account.service';
import { ACCOUNT_POLICIES } from '../src/accounts/account.policy';
import { ACCOUNT_SECURITY_CLOCK } from '../src/accounts/security/account-security.clock';
import { AccountTwoFactorService } from '../src/accounts/security/two-factor.service';
import { OAuthModule } from '../src/oauth/oauth.module';
import { OAUTH_SETTINGS, type OAuthProvider, type OAuthSettings } from '../src/oauth/oauth.config';
import { OAUTH_PROVIDER_CLIENT, type OAuthProviderClient } from '../src/oauth/oauth-provider';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { createIsolatedSchema, dropIsolatedSchema } from './helpers/account-security-fixture';

/**
 * WP 3.3b Sonnet checks: no sign-in path (password, OAuth code flow, Google One Tap, magic link) opens a
 * session for an enrolled account without the second factor; TOTP replay across two service instances;
 * lockout after five wrong codes; recovery codes; enrolment while the policy is off; magic link rules;
 * and a secret-leak scan of every response and every text column. PostgreSQL, stub mailer, injected clock.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_stepup_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticStepUp9!';
const clientId = 'synthetic-google-client', encryptionKey = 'synthetic-config-encryption-key-step-up-only', jwtSecret = 'synthetic-step-up-jwt-secret-at-least-32-chars';
const settings: OAuthSettings = { webOrigin: origin, secureCookies: false,
  google: { clientId, clientSecret: 'synthetic-only', code: true, oneTap: true },
  github: { clientId: 'synthetic-github-client', clientSecret: 'synthetic-only', code: true } };
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const verifier = new GoogleIdTokenVerifier({ audience: clientId,
  fetcher: vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=600' } })) });
function credential(nonce: string, subject: string, email: string) {
  const issued = Math.floor(Date.now() / 1000);
  const data = [JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' }), JSON.stringify({ iss: 'https://accounts.google.com', aud: clientId,
    sub: subject, email, email_verified: true, iat: issued - 1, exp: issued + 300, nonce })].map(value => Buffer.from(value).toString('base64url')).join('.');
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`;
}

run('sign-in step-up, TOTP replay, lockout, recovery codes and magic link (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, policies: PolicyService;
  let now = new Date();
  const mail: Array<{ email: string; purpose: string; ticket: string }> = [];
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, purpose, ticket) { mail.push({ email, purpose, ticket }); } };
  const identities = new Map<string, VerifiedOAuthIdentity>();
  const providerClient: OAuthProviderClient = {
    async code(provider, input) { const identity = identities.get(input.code); if (!identity || identity.provider !== provider) throw new Error('synthetic-provider-error'); return identity; },
    oneTap: (token, nonce) => verifier.verify(token, { nonce }),
  };
  /** Every response of the run (url, status, body text, headers) for the leak scan. */
  const seen: Array<{ url: string; text: string; headers: string }> = [];
  const secrets: { totp: Set<string>; recovery: Set<string> } = { totp: new Set(), recovery: new Set() };
  const track = <T extends request.Test>(call: T): T => {
    call.on('response', (res: request.Response) => { seen.push({ url: String(res.request?.url ?? ''), text: res.text ?? '', headers: JSON.stringify(res.headers) }); });
    return call;
  };
  const server = () => app.getHttpServer();
  const post = (path: string, body: object = {}, token?: string) => {
    const call = track(request(server()).post(`/api/authorize/${path}`).set('Origin', origin));
    return (token ? call.set('Authorization', `Bearer ${token}`) : call).send(body);
  };
  const get = (path: string, token: string) => track(request(server()).get(`/api/authorize/${path}`).set('Authorization', `Bearer ${token}`));
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  const code = (secret: string) => generateTotpCode({ secret, time: now.getTime() });
  /** A code for a step later than any used so far. */
  const freshCode = (secret: string) => { now = new Date(now.getTime() + 30_000); return code(secret); };
  const setPolicy = async (values: Record<string, unknown>) => {
    const current = await policies.view('account'); await policies.save('synthetic-operator', 'account', { expectedRevision: current.revision, values });
  };
  const sessions = async (userId: string) => (await q('SELECT count(*)::int AS n FROM "S".account_sessions WHERE "userId" = $1', [userId]))[0].n as number;
  const cookie = (response: { headers: Record<string, unknown> }) => ((response.headers['set-cookie'] as string[] | undefined) ?? []).map(value => value.split(';')[0]).join('; ');

  async function member(username: string) {
    const id = randomUUID();
    await q(`INSERT INTO "S".users (id, username, name, "typeId", email, "emailVerified", status, password) VALUES ($1,$2,$2,'member',$3,true,true,$4)`,
      [id, username, `${username}@example.invalid`, await new BcryptEncoder().encode(password)]);
    return id;
  }
  const login = (username: string) => post('login', { username, password });
  /** Password member with active two-factor. */
  async function enrolledMember(username: string) {
    const userId = await member(username);
    const token = (await login(username).expect(200)).body.token as string;
    const { secret } = (await post('two-factor/enrol', { password }, token).expect(200)).body as { secret: string };
    secrets.totp.add(secret);
    const { recoveryCodes } = (await post('two-factor/confirm', { code: freshCode(secret) }, token).expect(200)).body as { recoveryCodes: string[] };
    recoveryCodes.forEach(value => secrets.recovery.add(value));
    return { userId, secret, recoveryCodes, token };
  }
  /** The response must hand out a challenge only: no token, no cookie, no new session row. */
  function expectChallengeOnly(response: request.Response, before: number, userId: string) {
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ twoFactorRequired: true, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(response.body.token).toBeUndefined(); expect(response.body.refreshToken).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    return sessions(userId).then(after => expect(after).toBe(before));
  }

  // OAuth helpers (code flow and One Tap), as in oauth.persistent.e2e-spec.ts
  async function begin(provider: OAuthProvider) {
    const response = await post(`oauth/${provider}/start`, { mode: 'code', locale: 'en', returnPath: '/account' }).expect(200);
    return { state: new URL(response.body.authorizationUrl).searchParams.get('state')!, cookie: cookie(response) };
  }
  async function oauthProof(provider: OAuthProvider, subject: string, email?: string) {
    const flow = await begin(provider), codeValue = randomUUID();
    identities.set(codeValue, { provider, subject, email, emailVerified: Boolean(email), displayName: 'Synthetic member' });
    const response = await request(server()).get(`/api/authorize/oauth/${provider}/callback`).query({ state: flow.state, code: codeValue }).set('Cookie', flow.cookie).expect(302);
    const proof = new URLSearchParams(new URL(response.headers.location).hash.slice(1)).get('ticket')!;
    expect(proof).toHaveLength(43);
    return { proof, cookie: [flow.cookie, cookie(response)].filter(Boolean).join('; ') };
  }
  const oauthComplete = (provider: OAuthProvider, handoff: { proof: string; cookie: string }) =>
    post(`oauth/${provider}/complete`, { proof: handoff.proof }).set('Cookie', handoff.cookie);
  async function oneTapProof(subject: string, email: string) {
    const started = await post('oauth/google/start', { mode: 'onetap', locale: 'en' }).expect(200), browser = cookie(started);
    const handoff = await post('oauth/google/onetap', { intent: started.body.intent, credential: credential(started.body.nonce, subject, email) }).set('Cookie', browser).expect(200);
    return { proof: handoff.body.proof as string, cookie: [browser, cookie(handoff)].filter(Boolean).join('; ') };
  }

  beforeAll(async () => {
    const created = await createIsolatedSchema(databaseUrl!, schema);
    pool = created.pool; database = created.database;
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: jwtSecret, CONFIG_ENCRYPTION_KEY: encryptionKey };
    const limits = { points: 100_000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, login: limits, 'login-account': limits, 'session-refresh': limits,
        'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...ACCOUNT_POLICIES] }), AccountModule, OAuthModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(OAUTH_SETTINGS).useValue(settings).overrideProvider(OAUTH_PROVIDER_CLIENT).useValue(providerClient)
      .overrideProvider(ACCOUNT_SECURITY_CLOCK).useValue(() => now).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    policies = app.get(PolicyService);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); } finally { await dropIsolatedSchema(pool, schema); }
  });

  it('password sign-in asks for the second factor only once enrolment is confirmed', async () => {
    const userId = await member('step_pending');
    const token = (await login('step_pending').expect(200)).body.token as string;
    const { secret } = (await post('two-factor/enrol', { password }, token).expect(200)).body as { secret: string };
    secrets.totp.add(secret);
    expect((await get('two-factor/status', token).expect(200)).body).toMatchObject({ status: 'pending', recoveryCodesRemaining: 0 });
    // A pending enrolment is not a second factor: sign-in still goes straight through.
    expect((await login('step_pending').expect(200)).body.token).toBeTruthy();
    await post('two-factor/confirm', { code: freshCode(secret) }, token).expect(200);
    const before = await sessions(userId);
    await expectChallengeOnly(await login('step_pending'), before, userId);
    // A wrong password gives the usual 401, never a challenge.
    await post('login', { username: 'step_pending', password: 'wrong-password' }).expect(401);
  });

  it('OAuth code flow, One Tap and magic link all stop at the challenge for an enrolled account and finish with the code', async () => {
    await setPolicy({ magicLinkEnabled: true });
    // OAuth (GitHub, no email): first sign-in creates the account, a fresh session may enrol (password-less recent auth).
    const first = await oauthComplete('github', await oauthProof('github', 'stepup-github-subject')).expect(200);
    const gh = { userId: first.body.userId as string, token: first.body.token as string };
    const ghSecret = (await post('two-factor/enrol', {}, gh.token).expect(200)).body.secret as string; secrets.totp.add(ghSecret);
    (await post('two-factor/confirm', { code: freshCode(ghSecret) }, gh.token).expect(200)).body.recoveryCodes.forEach((value: string) => secrets.recovery.add(value));
    let before = await sessions(gh.userId);
    const stepped = await oauthComplete('github', await oauthProof('github', 'stepup-github-subject'));
    await expectChallengeOnly(stepped, before, gh.userId);
    expect(stepped.body.returnPath).toBe('/account');
    // The challenge is not a session: refresh and /me refuse it.
    await post('refresh').expect(401);
    await get('me', stepped.body.challenge).expect(401);
    const finished = await post('login/two-factor', { challenge: stepped.body.challenge, code: freshCode(ghSecret) }).expect(200);
    expect(finished.body.token).toBeTruthy(); expect(cookie(finished)).toContain('=');

    // Google One Tap, same account model with an e-mail.
    const tapEmail = 'stepup-tap@example.invalid';
    const tapFirst = await oauthComplete('google', await oneTapProof('stepup-tap-subject', tapEmail)).expect(200);
    const tap = { userId: tapFirst.body.userId as string, token: tapFirst.body.token as string };
    const tapSecret = (await post('two-factor/enrol', {}, tap.token).expect(200)).body.secret as string; secrets.totp.add(tapSecret);
    await post('two-factor/confirm', { code: freshCode(tapSecret) }, tap.token).expect(200);
    before = await sessions(tap.userId);
    const tapStep = await oauthComplete('google', await oneTapProof('stepup-tap-subject', tapEmail));
    await expectChallengeOnly(tapStep, before, tap.userId);
    await post('login/two-factor', { challenge: tapStep.body.challenge, code: '000000' }).expect(401);
    expect((await post('login/two-factor', { challenge: tapStep.body.challenge, code: freshCode(tapSecret) }).expect(200)).body.token).toBeTruthy();
    // Google code flow for the same subject goes through the same gate.
    const tapCode = await oauthComplete('google', await oauthProof('google', 'stepup-tap-subject', tapEmail));
    await expectChallengeOnly(tapCode, before + 1, tap.userId);

    // Magic link (existing enrolled account).
    const owner = await enrolledMember('step_link');
    mail.length = 0;
    await post('magic-link', { email: 'step_link@example.invalid' }).expect(200);
    await app.get(AccountService).settled();
    before = await sessions(owner.userId);
    const link = await post('magic-link/consume', { ticket: mail[0]!.ticket }).expect(200);
    await expectChallengeOnly(link, before, owner.userId);
    const done = await post('login/two-factor', { challenge: link.body.challenge, code: freshCode(owner.secret) }).expect(200);
    expect(done.body.token).toBeTruthy();
    await setPolicy({ magicLinkEnabled: null });
  });

  it('keeps stepping up enrolled accounts after the operator turns the enrolment policy off', async () => {
    const owner = await enrolledMember('step_policy_off');
    await setPolicy({ twoFactorEnabled: false });
    try {
      const before = await sessions(owner.userId);
      await expectChallengeOnly(await login('step_policy_off'), before, owner.userId);
      // New enrolment is refused while the policy is off, with the documented code, and writes nothing.
      const fresh = await member('step_policy_new');
      const token = (await login('step_policy_new').expect(200)).body.token as string;
      expect((await post('two-factor/enrol', { password }, token).expect(403)).body.code).toBe('TWO_FACTOR_DISABLED');
      expect(await q('SELECT 1 FROM "S".account_two_factor WHERE "userId" = $1', [fresh])).toEqual([]);
      expect((await get('two-factor/status', token).expect(200)).body).toMatchObject({ status: 'off', enrolmentAllowed: false });
      // The enrolled owner can still turn it off.
      const ownerToken = (await post('login/two-factor', { challenge: (await login('step_policy_off')).body.challenge, code: freshCode(owner.secret) }).expect(200)).body.token as string;
      await post('two-factor/disable', { password, code: freshCode(owner.secret) }, ownerToken).expect(200);
    } finally { await setPolicy({ twoFactorEnabled: null }); }
  });

  it('accepts a TOTP step once across two service instances', async () => {
    const owner = await enrolledMember('step_replay');
    const other = new AccountTwoFactorService(database, () => now, { JWT_SECRET: jwtSecret, CONFIG_ENCRYPTION_KEY: encryptionKey });
    const first = app.get(AccountTwoFactorService);
    const used = freshCode(owner.secret);
    expect(await database.$transaction(tx => first.verify(tx, owner.userId, { code: used }))).toBe(true);
    // A second process has no in-memory memory of the code: the database step guard must refuse it.
    expect(await database.$transaction(tx => other.verify(tx, owner.userId, { code: used }))).toBe(false);
    // Same through the HTTP path, and the previous step in the window is refused too.
    const challenge = (await login('step_replay').expect(200)).body.challenge as string;
    await post('login/two-factor', { challenge, code: used }).expect(401);
    const earlier = generateTotpCode({ secret: owner.secret, time: now.getTime() - 30_000 });
    await post('login/two-factor', { challenge, code: earlier }).expect(401);
    // Concurrent attempts with one fresh code across both instances: exactly one wins.
    const next = freshCode(owner.secret);
    const wins = await Promise.all([first, other, first, other].map(service => database.$transaction(tx => service.verify(tx, owner.userId, { code: next }))));
    expect(wins.filter(Boolean)).toHaveLength(1);
    // A wrong-then-right sequence still works with a later step (nothing was burnt by the failures).
    await post('login/two-factor', { challenge, code: freshCode(owner.secret) }).expect(200);
  });

  it('locks the code check after five wrong codes (keeping the challenge) and lifts the lock after 15 minutes', async () => {
    const fine = await enrolledMember('step_four_wrong');
    const fineChallenge = (await login('step_four_wrong').expect(200)).body.challenge as string;
    for (const wrong of ['100001', '100002', '100003', '100004']) await post('login/two-factor', { challenge: fineChallenge, code: wrong }).expect(401);
    expect((await post('login/two-factor', { challenge: fineChallenge, code: freshCode(fine.secret) }).expect(200)).body.token).toBeTruthy();

    const locked = await enrolledMember('step_locked');
    const challenge = (await login('step_locked').expect(200)).body.challenge as string;
    for (const wrong of ['200001', '200002', '200003', '200004', '200005']) {
      expect((await post('login/two-factor', { challenge, code: wrong }).expect(401)).body.code).toBe('TWO_FACTOR_CODE_INVALID');
    }
    // Even the right code is refused now, with the same code and no token; a fresh challenge does not help.
    const refused = await post('login/two-factor', { challenge, code: freshCode(locked.secret) }).expect(401);
    expect(refused.body.code).toBe('TWO_FACTOR_CODE_INVALID'); expect(refused.body.token).toBeUndefined();
    const secondChallenge = (await login('step_locked').expect(200)).body.challenge as string;
    await post('login/two-factor', { challenge: secondChallenge, code: freshCode(locked.secret) }).expect(401);
    // Account endpoints that take a code are locked too.
    await post('two-factor/disable', { password, code: freshCode(locked.secret) }, locked.token).expect(400);
    expect((await q('SELECT status FROM "S".account_two_factor WHERE "userId" = $1', [locked.userId]))[0].status).toBe('active');

    now = new Date(now.getTime() + 16 * 60_000);
    const later = (await login('step_locked').expect(200)).body.challenge as string;
    expect((await post('login/two-factor', { challenge: later, code: freshCode(locked.secret) }).expect(200)).body.token).toBeTruthy();
  });

  it('spends each recovery code once, accepts typing variants, and replaces the set on regeneration', async () => {
    const owner = await enrolledMember('step_recovery');
    const [first, second, third] = owner.recoveryCodes as [string, string, string];
    expect(first).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/i);
    const challenge = async () => (await login('step_recovery').expect(200)).body.challenge as string;
    await post('login/two-factor', { challenge: await challenge(), recoveryCode: first }).expect(200);
    expect((await post('login/two-factor', { challenge: await challenge(), recoveryCode: first }).expect(401)).body.code).toBe('TWO_FACTOR_CODE_INVALID');
    // Case, spaces and the hyphen are not significant.
    const variant = `  ${second.toUpperCase().replace('-', ' ')} `;
    await post('login/two-factor', { challenge: await challenge(), recoveryCode: variant }).expect(200);
    await post('login/two-factor', { challenge: await challenge(), recoveryCode: second }).expect(401);
    // Both factors, neither factor and malformed input are 400 and never consume anything.
    const live = await challenge();
    await post('login/two-factor', { challenge: live, code: '123456', recoveryCode: third }).expect(400);
    await post('login/two-factor', { challenge: live }).expect(400);
    await post('login/two-factor', { challenge: live, code: '12345' }).expect(400);
    expect((await q('SELECT count(*)::int AS n FROM "S".account_recovery_codes WHERE "userId" = $1 AND "usedAt" IS NULL', [owner.userId]))[0].n).toBe(8);
    // Regeneration needs a valid authenticator code and invalidates the old codes.
    const token = (await post('login/two-factor', { challenge: live, code: freshCode(owner.secret) }).expect(200)).body.token as string;
    await post('two-factor/recovery-codes', { password, code: '000000' }, token).expect(400);
    const regenerated = (await post('two-factor/recovery-codes', { password, code: freshCode(owner.secret) }, token).expect(200)).body.recoveryCodes as string[];
    regenerated.forEach(value => secrets.recovery.add(value));
    expect(regenerated).toHaveLength(10);
    await post('login/two-factor', { challenge: await challenge(), recoveryCode: third }).expect(401);
    await post('login/two-factor', { challenge: await challenge(), recoveryCode: regenerated[0] }).expect(200);
    // A recovery code can also switch two-factor off, and then it is one use only.
    await post('two-factor/disable', { password, recoveryCode: regenerated[1] }, token).expect(200);
    expect(await q('SELECT 1 FROM "S".account_recovery_codes WHERE "userId" = $1', [owner.userId])).toEqual([]);
    expect((await login('step_recovery').expect(200)).body.token).toBeTruthy();
  });

  it('mails magic links only for existing enabled accounts, once, within 15 minutes, without enumeration', async () => {
    await post('magic-link', { email: 'someone@example.invalid' }).expect(403);
    await setPolicy({ magicLinkEnabled: true });
    try {
      const plain = await member('link_plain'), disabled = await member('link_disabled');
      await q(`UPDATE "S".users SET status = false WHERE id = $1`, [disabled]);
      mail.length = 0;
      const known = await post('magic-link', { email: 'link_plain@example.invalid' }).expect(200);
      const unknown = await post('magic-link', { email: 'nobody-at-all@example.invalid' }).expect(200);
      const off = await post('magic-link', { email: 'link_disabled@example.invalid' }).expect(200);
      const mixedCase = await post('magic-link', { email: 'Link_Plain@Example.Invalid' }).expect(200);
      for (const other of [unknown, off, mixedCase]) {
        expect(other.body).toEqual(known.body); expect(other.text).toBe(known.text);
        expect(other.headers['content-length']).toBe(known.headers['content-length']);
        expect(Object.keys(other.headers).sort()).toEqual(Object.keys(known.headers).sort());
      }
      expect(known.body).toEqual({ accepted: true });
      await app.get(AccountService).settled();
      expect(mail.map(entry => entry.email).sort()).toEqual(['link_plain@example.invalid', 'link_plain@example.invalid']);
      expect(mail.every(entry => entry.purpose === 'magic-link')).toBe(true);
      // No account is ever created by a link request.
      expect(await q(`SELECT 1 FROM "S".users WHERE email IN ('nobody-at-all@example.invalid')`)).toEqual([]);

      // Single use, also under concurrency.
      const ticket = mail[0]!.ticket;
      const results = await Promise.all([1, 2, 3, 4].map(() => post('magic-link/consume', { ticket })));
      expect(results.filter(result => result.status === 200)).toHaveLength(1);
      expect(results.filter(result => result.status === 400)).toHaveLength(3);
      expect(await sessions(plain)).toBeGreaterThanOrEqual(1);
      // Purpose confusion: a link ticket is not an e-mail verification / reset ticket, and malformed tickets are 400.
      await post('verify-email', { ticket: mail[1]!.ticket }).expect(400);
      for (const bad of ['', 'short', 'x'.repeat(43), 12345]) await post('magic-link/consume', { ticket: bad }).expect(400);
      await post('magic-link/consume', {}).expect(400);
      // The one-time link marks the address as verified.
      await q(`UPDATE "S".users SET "emailVerified" = false WHERE id = $1`, [plain]);
      mail.length = 0;
      await post('magic-link', { email: 'link_plain@example.invalid' }).expect(200); await app.get(AccountService).settled();
      await post('magic-link/consume', { ticket: mail[0]!.ticket }).expect(200);
      expect((await q('SELECT "emailVerified" FROM "S".users WHERE id = $1', [plain]))[0].emailVerified).toBe(true);

      // Expiry (15 minutes) and the policy gate at consume time.
      mail.length = 0;
      await post('magic-link', { email: 'link_plain@example.invalid' }).expect(200); await app.get(AccountService).settled();
      const stale = mail[0]!.ticket;
      now = new Date(now.getTime() + 16 * 60_000);
      await post('magic-link/consume', { ticket: stale }).expect(400);
      mail.length = 0;
      await post('magic-link', { email: 'link_plain@example.invalid' }).expect(200); await app.get(AccountService).settled();
      await setPolicy({ magicLinkEnabled: false });
      expect((await post('magic-link/consume', { ticket: mail[0]!.ticket }).expect(403)).body.code).toBe('MAGIC_LINK_DISABLED');
    } finally { await setPolicy({ magicLinkEnabled: null }); }
  });

  it('refuses a two-factor challenge on every other ticket endpoint and a link ticket as a challenge', async () => {
    await setPolicy({ magicLinkEnabled: true });
    try {
      const owner = await enrolledMember('step_confusion');
      const challenge = (await login('step_confusion').expect(200)).body.challenge as string;
      await post('magic-link/consume', { ticket: challenge }).expect(400);
      await post('verify-email', { ticket: challenge }).expect(400);
      await post('reset-password', { ticket: challenge, password: 'AnotherSynthetic9!' }).expect(400);
      // The challenge survived all of that.
      mail.length = 0;
      await post('magic-link', { email: 'step_confusion@example.invalid' }).expect(200); await app.get(AccountService).settled();
      const asChallenge = await post('login/two-factor', { challenge: mail[0]!.ticket, code: freshCode(owner.secret) }).expect(400);
      expect(asChallenge.body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
      expect((await post('login/two-factor', { challenge, code: freshCode(owner.secret) }).expect(200)).body.token).toBeTruthy();
      // Expiry: 5 minutes.
      const expiring = (await login('step_confusion').expect(200)).body.challenge as string;
      now = new Date(now.getTime() + 5 * 60_000 + 1000);
      expect((await post('login/two-factor', { challenge: expiring, code: freshCode(owner.secret) }).expect(400)).body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    } finally { await setPolicy({ magicLinkEnabled: null }); }
  });

  it('never leaks a secret, recovery code, hash or key in any response or stored text', async () => {
    expect(secrets.totp.size).toBeGreaterThan(5); expect(secrets.recovery.size).toBeGreaterThan(20);
    const enrolOnly = /\/authorize\/two-factor\/enrol$/, codesAllowed = /\/authorize\/two-factor\/(confirm|recovery-codes)$/;
    for (const response of seen) {
      const blob = `${response.text}\n${response.headers}`;
      for (const forbidden of [encryptionKey, jwtSecret, password, 'secretCiphertext', 'codeHash', '$2b$', '$2a$', 'synthetic-only'])
        expect(blob, `${response.url} must not contain ${forbidden}`).not.toContain(forbidden);
      for (const secret of secrets.totp) if (!enrolOnly.test(response.url)) expect(blob, response.url).not.toContain(secret);
      for (const recovery of secrets.recovery) if (!codesAllowed.test(response.url)) expect(blob, response.url).not.toContain(recovery);
    }
    // Stored form: ciphertext is not the secret, and no text column anywhere holds plaintext secrets or codes.
    const columns = await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1
      AND data_type IN ('text', 'character varying', 'character', 'jsonb')`, [schema]);
    const needles = [...secrets.totp, ...secrets.recovery, ...[...secrets.recovery].map(value => value.replace('-', ''))];
    for (const { table_name: table, column_name: column } of columns.rows as Array<{ table_name: string; column_name: string }>) {
      const found = await pool.query(`SELECT 1 FROM "${schema}"."${table}" WHERE "${column}"::text = ANY($1::text[]) OR "${column}"::text LIKE ANY($2::text[]) LIMIT 1`,
        [needles, needles.map(value => `%${value}%`)]);
      expect(found.rows, `${table}.${column}`).toEqual([]);
    }
    for (const row of await q('SELECT "secretCiphertext" AS c FROM "S".account_two_factor')) expect(row.c).toMatch(/^v\d+\./);
  });
});
