import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { GoogleIdTokenVerifier, PermissionsGuard, ZuckerAuthModule, type VerifiedOAuthIdentity } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { ApplicationDatabase } from '../src/database';
import { OAuthModule } from '../src/oauth/oauth.module';
import { OAUTH_SETTINGS, oauthSettings, type OAuthProvider, type OAuthSettings } from '../src/oauth/oauth.config';
import { OAUTH_PROVIDER_CLIENT, type OAuthCodeInput, type OAuthProviderClient } from '../src/oauth/oauth-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `zucker_oauth_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4202', password = 'SyntheticUser9!', clientId = 'synthetic-google-client';
const run = databaseUrl ? describe : describe.skip;
const settings: OAuthSettings = { webOrigin: origin, secureCookies: false,
  google: { clientId, clientSecret: 'synthetic-only', code: true, oneTap: true },
  github: { clientId: 'synthetic-github-client', clientSecret: 'synthetic-only', code: true } };
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const verifier = new GoogleIdTokenVerifier({ audience: clientId,
  fetcher: vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=600' } })) });
function credential(nonce: string, extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const data = [JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' }), JSON.stringify({ iss: 'https://accounts.google.com', aud: clientId,
    sub: 'one-tap-subject', email: 'onetap@example.invalid', email_verified: true, iat: now - 1, exp: now + 300, nonce, ...extra })]
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`;
}

run('durable OAuth template flows', () => {
  let app: INestApplication, pool: Pool, scopedUrl: string;
  const identities = new Map<string, VerifiedOAuthIdentity>();
  const exchanges: Array<{ provider: OAuthProvider; code: string; input: OAuthCodeInput }> = [];
  const deliveries: Array<{ email: string; ticket: string }> = [];
  const providerClient: OAuthProviderClient = {
    async code(provider, input) {
      exchanges.push({ provider, code: input.code, input });
      const identity = identities.get(input.code);
      if (!identity || identity.provider !== provider) throw new Error('synthetic-private-provider-error');
      return identity;
    },
    oneTap: (token, nonce) => verifier.verify(token, { nonce }),
  };
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.push({ email, ticket }); } };
  async function startApp(config = settings) {
    const db = new ApplicationDatabase(scopedUrl);
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => db }), ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-oauth-test-secret-only-long', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 } } }), AccountModule, OAuthModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(OAUTH_SETTINGS).useValue(config)
      .overrideProvider(OAUTH_PROVIDER_CLIENT).useValue(providerClient).compile();
    const instance = module.createNestApplication(); instance.setGlobalPrefix('api'); instance.useGlobalFilters(new HttpExceptionFilter());
    await instance.init(); return instance;
  }
  const cookie = (response: { headers: Record<string, unknown> }) => ((response.headers['set-cookie'] as string[] | undefined) ?? []).map(value => value.split(';')[0]).join('; ');
  const post = (path: string, body: object = {}) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
  async function member(username: string) {
    const email = `${username}@example.invalid`;
    await post('register', { username, email, password }).expect(201);
    await post('verify-email', { ticket: deliveries.findLast(delivery => delivery.email === email)!.ticket }).expect(200);
    const login = await post('login', { username, password }).expect(200);
    return { email, userId: login.body.userId as string, token: login.body.token as string, cookie: cookie(login) };
  }
  async function begin(provider: OAuthProvider, owner?: Awaited<ReturnType<typeof member>>, returnPath = '/account') {
    const call = post(`oauth/${provider}/${owner ? 'link/' : ''}start`, { mode: 'code', locale: 'en', returnPath });
    if (owner) call.set('Authorization', `Bearer ${owner.token}`).set('Cookie', owner.cookie);
    const response = await call.expect(200);
    const url = new URL(response.body.authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    return { state: url.searchParams.get('state')!, cookie: [cookie(response), owner?.cookie].filter(Boolean).join('; ') };
  }
  async function callback(provider: OAuthProvider, code: string, flow: { state: string; cookie: string }, headers: Record<string, string> = {}) {
    const response = await request(app.getHttpServer()).get(`/api/authorize/oauth/${provider}/callback`).query({ state: flow.state, code }).set('Cookie', flow.cookie).set(headers).expect(302);
    const url = new URL(response.headers.location);
    const proof = new URLSearchParams(url.hash.slice(1)).get('ticket');
    if (proof) expect(cookie(response)).toContain('zucker-oauth-browser=');
    return { url, proof };
  }
  const complete = (provider: OAuthProvider, proof: string, browserCookie: string, owner?: Awaited<ReturnType<typeof member>>) => {
    const call = post(`oauth/${provider}/${owner ? 'link/' : ''}complete`, { proof }).set('Cookie', browserCookie);
    return owner ? call.set('Authorization', `Bearer ${owner.token}`) : call;
  };
  const identity = (provider: OAuthProvider, subject: string, email?: string): VerifiedOAuthIdentity => ({ provider, subject, email, emailVerified: Boolean(email), displayName: 'Synthetic member' });

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const connection = await pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query(`CREATE SCHEMA "${schema}"`); await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        await connection.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href; app = await startApp();
  });
  afterAll(async () => {
    try { await app?.close(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('keeps providers off without configuration and pins raw SQL to the isolated schema', async () => {
    const disabled = await startApp(oauthSettings({ WEB_URL: origin }));
    try {
      const available = await request(disabled.getHttpServer()).get('/api/authorize/oauth/providers').expect(200);
      expect(available.body).toEqual({ providers: [] });
      await request(disabled.getHttpServer()).post('/api/authorize/oauth/google/start').set('Origin', origin).send({}).expect(404);
    } finally { await disabled.close(); }
    const db = app.get<ApplicationDatabase>('DATABASE_ADAPTER');
    const result = await db.transaction(tx => tx.query<{ schema: string }>('SELECT current_schema() AS schema'));
    expect(result.rows).toEqual([{ schema }]); expect(schema).not.toBe('public');
    const available = await request(app.getHttpServer()).get('/api/authorize/oauth/providers').expect(200);
    expect(available.body.providers).toHaveLength(2); expect(JSON.stringify(available.body)).not.toContain('synthetic-only');
  });

  it('checks origin, provider and browser before consuming durable state, then rejects replay', async () => {
    await post('oauth/google/start', {}).set('Origin', 'https://foreign.invalid').expect(403);
    const flow = await begin('google', undefined, '/billing/return?orderId=synthetic-order'); identities.set('state-code', identity('google', 'state-subject', 'state@example.invalid'));
    const wrong = await callback('google', 'state-code', { ...flow, cookie: `zucker-oauth-browser=${'x'.repeat(43)}` }); expect(wrong.proof).toBeNull();
    expect((await callback('github', 'state-code', flow)).proof).toBeNull();
    expect((await callback('google', 'state-code', flow, { Origin: 'https://foreign.invalid' })).proof).toBeNull();
    const valid = await callback('google', 'state-code', flow); expect(valid.proof).toHaveLength(43);
    expect((await callback('google', 'state-code', flow)).proof).toBeNull();
    expect(exchanges.filter(value => value.code === 'state-code')).toHaveLength(1);
    expect(exchanges.find(value => value.code === 'state-code')!.input.codeVerifier).toHaveLength(43);
    const completed = await complete('google', valid.proof!, flow.cookie).expect(200);
    expect(completed.body.returnPath).toBe('/billing/return?orderId=synthetic-order');
    await complete('google', valid.proof!, flow.cookie).expect(400);
  });

  it('does not reflect provider errors, credentials or state into callback failures', async () => {
    const flow = await begin('github');
    const result = await callback('github', 'synthetic-private-provider-error', flow);
    expect(result.url.searchParams.get('error')).toBe('oauth_failed');
    expect(result.url.href).not.toContain('synthetic-private'); expect(result.url.href).not.toContain(flow.state);
    const rows = await pool.query(`SELECT "accessToken", "refreshToken" FROM "${schema}".third_party_binds`);
    expect(rows.rows.every(row => row.accessToken === null && row.refreshToken === null)).toBe(true);
  });
  it('persists only supported local CMS/subscription OAuth return paths', async () => {
    const db = app.get<ApplicationDatabase>('DATABASE_ADAPTER');
    for (const [input, expected] of [
      ['/content/manage', '/content/manage'], ['/en/content/manage?page=2', '/content/manage?page=2'],
      ['/zh/content/manage/entry-1?tab=body', '/content/manage/entry-1?tab=body'],
      ['/en/billing/subscriptions/local-order?page=2', '/billing/subscriptions/local-order?page=2'],
      ['/content/managed', '/dashboard'], ['/content/public', '/dashboard'], ['/fr/content/manage', '/dashboard'],
      ['https://evil.invalid/content/manage', '/dashboard'], ['//evil.invalid/content/manage', '/dashboard'],
      ['/content/manage/%2f%2fevil.invalid', '/dashboard'], ['/content/manage/%252f%252fevil.invalid', '/dashboard'],
      ['/content/manage/../public', '/dashboard'], ['/content/manage/%2e%2e/public', '/dashboard'],
      ['/en/content/manage/entry%5c..%5cpublic', '/dashboard'], ['/en/content/manage/entry%0d%0aLocation:evil', '/dashboard'],
    ]) {
      const flow = await begin('github', undefined, input);
      const rows = await db.model('accountOAuthIntents').findMany({ where: { tokenHash: createHash('sha256').update(flow.state).digest('hex') }, take: 1 }) as Array<{ returnPath: string }>;
      expect(rows[0]?.returnPath, input).toBe(expected);
    }
  });
  it('completes the verified CMS OAuth handoff with its normalized management destination', async () => {
    const flow = await begin('github', undefined, '/zh/content/manage/entry-1?tab=body');
    identities.set('cms-return-code', identity('github', 'cms-return-subject'));
    const verified = await callback('github', 'cms-return-code', flow);
    expect(verified.proof).toBeTruthy();
    const completed = await complete('github', verified.proof ?? '', flow.cookie).expect(200);
    expect(completed.body.returnPath).toBe('/content/manage/entry-1?tab=body');
  });

  it('verifies One Tap with the stored nonce and rejects client nonce injection and replay', async () => {
    const beginTap = () => post('oauth/google/start', { mode: 'onetap', locale: 'en' });
    const started = await beginTap().expect(200), browser = cookie(started);
    await post('oauth/google/onetap', { intent: started.body.intent, credential: credential(started.body.nonce), nonce: started.body.nonce }).set('Cookie', browser).expect(400);
    const handoff = await post('oauth/google/onetap', { intent: started.body.intent, credential: credential(started.body.nonce) }).set('Cookie', browser).expect(200);
    await post('oauth/google/onetap', { intent: started.body.intent, credential: credential(started.body.nonce) }).set('Cookie', browser).expect(400);
    expect(cookie(handoff)).toContain('zucker-oauth-browser=');
    await complete('google', handoff.body.proof, browser).expect(200);
    const bad = await beginTap().expect(200);
    await post('oauth/google/onetap', { intent: bad.body.intent, credential: credential('attacker-selected-nonce') }).set('Cookie', cookie(bad)).expect(401);
  });

  it('allows a verified provider subject without an email through explicit oauth sessions', async () => {
    identities.set('no-email', identity('github', 'no-email-subject'));
    const flow = await begin('github'), callbackResult = await callback('github', 'no-email', flow);
    const login = await complete('github', callbackResult.proof!, flow.cookie).expect(200);
    const me = await request(app.getHttpServer()).get('/api/authorize/me').set('Authorization', `Bearer ${login.body.token}`).expect(200);
    expect(me.body.email).toBeNull(); expect(me.body.emailVerified).toBe(false);
    await post('refresh').set('Cookie', cookie(login)).expect(200);
    await post('login', { username: me.body.username, password }).expect(401);
    await request(app.getHttpServer()).delete('/api/authorize/oauth/connections/github').set('Origin', origin)
      .set('Authorization', `Bearer ${login.body.token}`).expect(409);
  });

  it('never merges by email and rolls back proof claims until the owner explicitly links', async () => {
    const owner = await member('existingemail'); identities.set('same-email', identity('github', 'same-email-subject', owner.email));
    const loginFlow = await begin('github'), loginProof = await callback('github', 'same-email', loginFlow);
    await complete('github', loginProof.proof!, loginFlow.cookie).expect(409);
    const rows = await pool.query(`SELECT "consumedAt" FROM "${schema}".account_oauth_proofs WHERE "providerAccountId"=$1`, ['same-email-subject']);
    expect(rows.rows[0].consumedAt).toBeNull();
    const linkFlow = await begin('github', owner), linkProof = await callback('github', 'same-email', linkFlow);
    const wrongOwner = await member('otherowner');
    await complete('github', linkProof.proof!, linkFlow.cookie, wrongOwner).expect(400);
    await complete('github', linkProof.proof!, linkFlow.cookie, owner).expect(200);
    const binding = await pool.query(`SELECT "userId" FROM "${schema}".third_party_binds WHERE provider='github' AND "providerAccountId"=$1`, ['same-email-subject']);
    expect(binding.rows).toEqual([{ userId: owner.userId }]);
    await complete('github', linkProof.proof!, linkFlow.cookie, owner).expect(400);
  });

  it('serializes concurrent provider logins across independent application instances', async () => {
    identities.set('parallel-code', identity('github', 'parallel-subject'));
    const a = await begin('github'), b = await begin('github');
    const pa = await callback('github', 'parallel-code', a), pb = await callback('github', 'parallel-code', b);
    const otherApp = await startApp();
    try {
      const [left, right] = await Promise.all([complete('github', pa.proof!, a.cookie),
        request(otherApp.getHttpServer()).post('/api/authorize/oauth/github/complete').set('Origin', origin).set('Cookie', b.cookie).send({ proof: pb.proof })]);
      expect([left.status, right.status]).toEqual([200, 200]); expect(left.body.userId).toBe(right.body.userId);
      const bindings = await pool.query(`SELECT id FROM "${schema}".third_party_binds WHERE "providerAccountId"=$1`, ['parallel-subject']); expect(bindings.rowCount).toBe(1);
    } finally { await otherApp.close(); }
  });

  it('binds a provider subject to only one concurrent owner and preserves the failed proof', async () => {
    const left = await member('linkleft'), right = await member('linkright'); identities.set('owned-once', identity('github', 'owned-once-subject'));
    const a = await begin('github', left), b = await begin('github', right);
    const pa = await callback('github', 'owned-once', a), pb = await callback('github', 'owned-once', b);
    const outcomes = await Promise.all([complete('github', pa.proof!, a.cookie, left), complete('github', pb.proof!, b.cookie, right)]);
    expect(outcomes.map(value => value.status).sort()).toEqual([200, 409]);
    const proofs = await pool.query(`SELECT "consumedAt" FROM "${schema}".account_oauth_proofs WHERE "providerAccountId"=$1`, ['owned-once-subject']);
    expect(proofs.rows.filter(row => row.consumedAt === null)).toHaveLength(1);
  });
  it('preserves one usable provider when two passwordless connections are unlinked concurrently', async () => {
    identities.set('multi-google', identity('google', 'multi-google-subject'));
    const google = await begin('google'), proof = await callback('google', 'multi-google', google);
    const login = await complete('google', proof.proof!, google.cookie).expect(200);
    const owner = { userId: login.body.userId, token: login.body.token, cookie: cookie(login), email: '' };
    identities.set('multi-github', identity('github', 'multi-github-subject'));
    const github = await begin('github', owner), linked = await callback('github', 'multi-github', github);
    await complete('github', linked.proof!, github.cookie, owner).expect(200);
    const outcomes = await Promise.all(['google', 'github'].map(provider => request(app.getHttpServer())
      .delete(`/api/authorize/oauth/connections/${provider}`).set('Origin', origin).set('Authorization', `Bearer ${owner.token}`)));
    expect(outcomes.filter(value => value.status === 200)).toHaveLength(1);
    expect(outcomes.filter(value => [401, 409].includes(value.status))).toHaveLength(1);
    const rows = await pool.query(`SELECT id FROM "${schema}".third_party_binds WHERE "userId"=$1`, [owner.userId]);
    expect(rows.rowCount).toBe(1);
  });

});
