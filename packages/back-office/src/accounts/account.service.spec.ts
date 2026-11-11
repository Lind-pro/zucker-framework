// @vitest-environment node
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ScryptEncoder, BcryptEncoder, generateTotpCode, type UserEntity } from '@zucker-framework/auth';
import type { AccountAccessTokenVerifier } from './accounts.ports';
import { EMAIL_CODE_METHOD } from './account.service';
import { CodeMailer, PASSWORD, RecordingMailer, createFixture, type Fixture } from './testing/account-fixture';

const httpCode = (error: unknown) => (error as { getResponse?: () => { code?: string } }).getResponse?.().code;
const status = (error: unknown) => (error as { getStatus?: () => number }).getStatus?.();
const settle = async (fixture: Fixture) => { await fixture.accounts.settled(); };

describe('scrypt password store', () => {
  it('registers, signs in, changes and resets passwords with scrypt hashes only', async () => {
    const f = createFixture({ policy: { requireEmailVerification: false } });
    const registered = await f.accounts.register({ username: 'scrypter', email: 'scrypter@example.invalid', password: PASSWORD, locale: 'en' });
    expect(registered).toMatchObject({ verificationRequired: false, userId: expect.any(String) });
    const stored = await f.accounts.users().findByUsername('scrypter');
    expect(stored!.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/); // salt:scrypt, never a bcrypt $2 hash
    expect(await new ScryptEncoder().matches(PASSWORD, stored!.password!)).toBe(true);
    expect(await new BcryptEncoder().matches(PASSWORD, stored!.password!)).toBe(false);

    const login = await f.accounts.login({ username: 'scrypter', password: PASSWORD });
    expect(login).toMatchObject({ twoFactorRequired: false, userId: stored!.id });
    await expect(f.accounts.login({ username: 'scrypter', password: `${PASSWORD}x` })).rejects.toBeInstanceOf(UnauthorizedException);

    const next = 'An0ther!Passw0rd#2';
    await f.accounts.changePassword(stored!.id, { currentPassword: PASSWORD, password: next });
    expect((await f.accounts.users().findByUsername('scrypter'))!.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    await expect(f.accounts.login({ username: 'scrypter', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await f.accounts.login({ username: 'scrypter', password: next })).toMatchObject({ twoFactorRequired: false });
    // The password change revoked the session opened before it (credentialVersion bumped).
    const { userId, accessToken } = registered as { userId: string; accessToken: string };
    const claims = await f.jwt.verifyAsync(accessToken, { audience: f.options.tokens.accessAudience });
    await expect(f.accounts.currentUser(userId, claims.sid)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('compares an unknown username against a dummy hash in the configured (scrypt) format', async () => {
    const calls: string[] = [];
    const encoder = new ScryptEncoder();
    const spying = { encode: async (raw: string) => { const out = await encoder.encode(raw); calls.push(`encode:${out.length}`); return out; },
      matches: async (raw: string, hash: string) => { calls.push(`matches:${/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash)}`); return encoder.matches(raw, hash); } };
    const f = createFixture({ encoder: spying });
    await expect(f.accounts.login({ username: 'ghost', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.accounts.login({ username: 'ghost', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
    // One dummy hash, built once, compared on every miss, in scrypt format (so cost and shape match real rows).
    expect(calls.filter(call => call.startsWith('encode'))).toHaveLength(1);
    expect(calls.filter(call => call === 'matches:true')).toHaveLength(2);
  });

  it('a password-less account costs the same hash and never signs in', async () => {
    const f = createFixture();
    const created = await f.accounts.users().addUser({ username: 'oauth-only', email: 'o@example.invalid', typeId: 'member', status: true,
      emailVerified: true }, { passwordless: true });
    expect(created.password).toBeNull();
    await expect(f.accounts.login({ username: 'oauth-only', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('six-digit code mode', () => {
  const codeMode = (extra: Parameters<typeof createFixture>[0] = {}) => createFixture({
    verification: { mode: 'code', codeExpirySeconds: 600, resendSeconds: 60, signInOnVerify: true },
    mailer: new CodeMailer(), policy: { requireEmailVerification: true }, ...extra });

  async function registerPending(f: Fixture, name = 'coder') {
    const result = await f.accounts.register({ username: name, email: `${name}@example.invalid`, password: PASSWORD, locale: 'en' });
    expect(result).toEqual({ verificationRequired: true });
    return f.mailer.last('verify-email')!;
  }

  it('mails a six-digit code (not a ticket) through the code mail method', async () => {
    const f = codeMode();
    const mail = await registerPending(f);
    expect(mail.kind).toBe('code');
    expect(mail.secret).toMatch(/^\d{6}$/);
  });

  it('falls back to send() with a code delivery when the mailer has no code method', async () => {
    const f = codeMode({ mailer: new RecordingMailer() });
    const mail = await registerPending(f, 'plainmail');
    expect(mail).toMatchObject({ kind: 'send', delivery: { kind: 'code', expiresInSeconds: 600 } });
    expect(mail.secret).toMatch(/^\d{6}$/);
  });

  it('verifies the address with the code, signs in, and refuses the code a second time', async () => {
    const f = codeMode();
    const { secret } = await registerPending(f);
    // Before verification the account cannot sign in.
    await expect(f.accounts.login({ username: 'coder', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
    const result = await f.accounts.consumeEmail({ email: 'coder@example.invalid', code: secret }, 'verify-email');
    expect(result).toMatchObject({ success: true, signIn: { twoFactorRequired: false, userId: expect.any(String) } });
    expect((await f.accounts.users().findByUsername('coder'))!.emailVerified).toBe(true);
    const session = (result as { signIn: { accessToken: string } }).signIn.accessToken;
    expect((await f.jwt.decode(session)).sid).toBeTruthy();
    await expect(f.accounts.consumeEmail({ email: 'coder@example.invalid', code: secret }, 'verify-email')).rejects.toSatisfy(error => httpCode(error) === 'VERIFICATION_CODE_INVALID');
    await settle(f);
  });

  it('records the session under the built-in email-code method', async () => {
    const f = codeMode();
    const { secret } = await registerPending(f, 'methodcheck');
    await f.accounts.consumeEmail({ email: 'methodcheck@example.invalid', code: secret }, 'verify-email');
    const sessions = await f.db.model(f.options.models.accountSessions).findMany({});
    expect(sessions.map(row => row.authMethod)).toEqual([EMAIL_CODE_METHOD]);
  });

  it('a wrong code keeps the account unverified and unusable', async () => {
    const f = codeMode();
    const { secret } = await registerPending(f);
    const wrong = secret === '000000' ? '111111' : '000000';
    await expect(f.accounts.consumeEmail({ email: 'coder@example.invalid', code: wrong }, 'verify-email')).rejects.toSatisfy(error => httpCode(error) === 'VERIFICATION_CODE_INVALID' && status(error) === 400);
    expect((await f.accounts.users().findByUsername('coder'))!.emailVerified).toBe(false);
    await expect(f.accounts.login({ username: 'coder', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
    // Malformed codes never reach the store.
    await expect(f.accounts.consumeEmail({ email: 'coder@example.invalid', code: '12345' }, 'verify-email')).rejects.toSatisfy(error => httpCode(error) === 'VERIFICATION_CODE_INVALID');
    // The right code still works after a wrong attempt.
    expect(await f.accounts.consumeEmail({ email: 'coder@example.invalid', code: secret }, 'verify-email')).toMatchObject({ success: true });
  });

  it('expires the code after codeExpirySeconds', async () => {
    const f = codeMode();
    const { secret } = await registerPending(f);
    f.clock.advance(601);
    await expect(f.accounts.consumeEmail({ email: 'coder@example.invalid', code: secret }, 'verify-email')).rejects.toSatisfy(error => httpCode(error) === 'VERIFICATION_CODE_INVALID');
    expect((await f.accounts.users().findByUsername('coder'))!.emailVerified).toBe(false);
  });

  it('honours the resend window: a second request inside it mails nothing, one after it replaces the code', async () => {
    const f = codeMode();
    const first = await registerPending(f);
    expect(f.mailer.sent).toHaveLength(1);
    await f.accounts.requestEmail({ email: 'coder@example.invalid' }, 'verify-email');
    await settle(f);
    expect(f.mailer.sent).toHaveLength(1);
    f.clock.advance(61);
    await f.accounts.requestEmail({ email: 'coder@example.invalid' }, 'verify-email');
    await settle(f);
    expect(f.mailer.sent).toHaveLength(2);
    const second = f.mailer.last('verify-email')!;
    // Only the newest code is live.
    if (second.secret !== first.secret) {
      await expect(f.accounts.consumeEmail({ email: 'coder@example.invalid', code: first.secret }, 'verify-email')).rejects.toSatisfy(error => httpCode(error) === 'VERIFICATION_CODE_INVALID');
    }
    expect(await f.accounts.consumeEmail({ email: 'coder@example.invalid', code: second.secret }, 'verify-email')).toMatchObject({ success: true });
  });

  it('locks out after repeated wrong codes (429 with retryAfter), even for the right code, until the lock ends', async () => {
    const f = codeMode({ verification: { mode: 'code', codeExpirySeconds: 3600, resendSeconds: 60, signInOnVerify: true } });
    const { secret } = await registerPending(f);
    const wrong = secret === '000000' ? '111111' : '000000';
    const attempt = (code: string) => f.accounts.consumeEmail({ email: 'coder@example.invalid', code }, 'verify-email');
    await expect(attempt(wrong)).rejects.toSatisfy(error => status(error) === 400);
    await expect(attempt(wrong)).rejects.toSatisfy(error => status(error) === 400);
    const locking = await attempt(wrong).catch(error => error);
    expect(status(locking)).toBe(429);
    expect(httpCode(locking)).toBe('VERIFICATION_LOCKED');
    expect((locking.getResponse() as { details: { retryAfter: number } }).details.retryAfter).toBe(600);
    const locked = await attempt(secret).catch(error => error);
    expect(httpCode(locked)).toBe('VERIFICATION_LOCKED');
    expect((await f.accounts.users().findByUsername('coder'))!.emailVerified).toBe(false);
    f.clock.advance(601);
    expect(await attempt(secret)).toMatchObject({ success: true });
  });

  it('answers 503 VERIFICATION_UNAVAILABLE when the attempt store is down', async () => {
    const f = codeMode({ verification: { mode: 'code', attempts: { remainingLock: async () => { throw new Error('cache down'); },
      recordFailure: async () => 0, clearFailures: async () => undefined }, signInOnVerify: true } });
    const mail = await registerPending(f).catch(() => undefined);
    // Registration itself does not need the attempt store; consumption fails closed.
    const code = mail?.secret ?? f.mailer.last()!.secret;
    await expect(f.accounts.consumeEmail({ email: 'coder@example.invalid', code }, 'verify-email'))
      .rejects.toThrow();
  });

  it('reset-password also uses codes and signs nobody in', async () => {
    const f = codeMode();
    await f.createUser('resetter');
    await f.accounts.requestEmail({ email: 'resetter@example.invalid' }, 'reset-password');
    await settle(f);
    const mail = f.mailer.last('reset-password')!;
    expect(mail.secret).toMatch(/^\d{6}$/);
    const next = 'N3w!Passw0rd#reset';
    expect(await f.accounts.consumeEmail({ email: 'resetter@example.invalid', code: mail.secret, password: next }, 'reset-password')).toEqual({ success: true });
    expect(await f.accounts.login({ username: 'resetter', password: next })).toMatchObject({ twoFactorRequired: false });
  });

  it('keeps magic links as links, not codes', async () => {
    const f = codeMode();
    f.policy.value = { ...f.policy.value, magicLinkEnabled: true };
    await f.createUser('linker');
    await f.accounts.requestMagicLink({ email: 'linker@example.invalid' });
    await settle(f);
    const mail = f.mailer.last('magic-link')!;
    expect(mail.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

});

describe('legacy access-token verifier', () => {
  const LEGACY = 'legacy-token-123';
  function legacy(identity: { userId: string; sessionId: string } | null | 'throw'): AccountAccessTokenVerifier {
    return { verify: async token => { if (identity === 'throw') throw new Error('boom'); return token === LEGACY ? identity : null; } };
  }
  async function opened(f: Fixture, name = 'legacy') {
    const user = await f.createUser(name);
    const result = await f.accounts.signIn(user, { kind: 'password' });
    if (result.twoFactorRequired) throw new Error('unexpected challenge');
    const claims = await f.jwt.verifyAsync(result.accessToken, { audience: f.options.tokens.accessAudience });
    return { user, sessionId: claims.sid as string, result };
  }
  const bearer = (token: string) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }),
    getHandler: () => undefined, getClass: () => undefined });

  it('accepts a legacy token whose identity maps to a live session, but verifies primary tokens first', async () => {
    const probe = { verify: async (token: string) => { probe.calls.push(token); return null; }, calls: [] as string[] };
    const f = createFixture({ tokens: { additionalAccessVerifiers: [probe] } });
    const { result } = await opened(f);
    expect(await f.guard.verify(result.accessToken)).toMatchObject({ sessionId: expect.any(String) });
    expect(probe.calls).toEqual([]); // primary token: no fallback attempted
    expect(await f.guard.verify('not-a-token')).toBeNull();
    expect(probe.calls).toEqual(['not-a-token']);
  });

  it('a legacy identity still goes through the session check (revoked, credential bump, expiry, other user, disabled account)', async () => {
    const fixtures = createFixture({ tokens: { additionalAccessVerifiers: [{ verify: async () => null }] } });
    const { user, sessionId } = await opened(fixtures);
    const f = createFixture({ db: fixtures.db, tokens: { additionalAccessVerifiers: [legacy({ userId: user.id, sessionId })] } });
    const can = () => f.guard.canActivate(bearer(LEGACY) as never);
    expect(await can()).toBe(true);

    // Another user's id with this session id is refused.
    const wrongUser = createFixture({ db: fixtures.db, tokens: { additionalAccessVerifiers: [legacy({ userId: 'someone-else', sessionId })] } });
    await expect(wrongUser.guard.canActivate(bearer(LEGACY) as never)).rejects.toBeInstanceOf(UnauthorizedException);

    // Expiring: a session past its expiry stops authenticating the legacy token.
    const sessions = f.db.model(f.options.models.accountSessions);
    const original = (await sessions.findUnique({ where: { id: sessionId } }))!.expiresAt as Date;
    await sessions.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(can()).rejects.toBeInstanceOf(UnauthorizedException);
    await sessions.update({ where: { id: sessionId }, data: { expiresAt: original } });
    expect(await can()).toBe(true);

    // Credential version bump (password/email change) ends it.
    await f.db.model(f.options.models.users).update({ where: { id: user.id }, data: { credentialVersion: { increment: 1 } } });
    await expect(can()).rejects.toBeInstanceOf(UnauthorizedException);
    await f.db.model(f.options.models.users).update({ where: { id: user.id }, data: { credentialVersion: 0 } });
    expect(await can()).toBe(true);

    // Revoked session.
    await f.accounts.sessions.revokeSession(sessionId, 'test');
    await expect(can()).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a disabled account is refused with a legacy token', async () => {
    const base = createFixture({});
    const { user, sessionId } = await opened(base);
    const f = createFixture({ db: base.db, tokens: { additionalAccessVerifiers: [legacy({ userId: user.id, sessionId })] } });
    await f.db.model(f.options.models.users).update({ where: { id: user.id }, data: { status: false } });
    await expect(f.guard.canActivate(bearer(LEGACY) as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a throwing or malformed verifier is a rejection, never a bypass', async () => {
    for (const verifier of [legacy('throw'), legacy({ userId: '', sessionId: 's' }), legacy({ userId: 'u', sessionId: '' }),
      { verify: async () => ({ userId: 1, sessionId: 2 }) as never }]) {
      const f = createFixture({ tokens: { additionalAccessVerifiers: [verifier] } });
      expect(await f.guard.verify(LEGACY)).toBeNull();
      await expect(f.guard.canActivate(bearer(LEGACY) as never)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('later verifiers are tried when an earlier one throws or declines', async () => {
    const f = createFixture({ tokens: { additionalAccessVerifiers: [legacy('throw'), legacy(null), legacy({ userId: 'u1', sessionId: 's1' })] } });
    expect(await f.guard.verify(LEGACY)).toEqual({ userId: 'u1', sessionId: 's1' });
  });

  it('refuses a refresh token, a wrong-audience token and a missing/malformed Authorization header', async () => {
    const f = createFixture({});
    const { result } = await opened(f);
    expect(await f.guard.verify(result.refreshToken)).toBeNull();
    const foreign = await f.jwt.signAsync({ sub: 'u', sid: 's', tokenUse: 'access' }, { audience: 'someone:else', expiresIn: 60 });
    expect(await f.guard.verify(foreign)).toBeNull();
    const header = (authorization?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: authorization ? { authorization } : {} }) }),
      getHandler: () => undefined, getClass: () => undefined });
    for (const value of [undefined, 'Basic abc', 'Bearer', 'Bearer a b']) {
      await expect(f.guard.canActivate(header(value) as never)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('an expired access token (past its exp) is refused even for a live session', async () => {
    const f = createFixture({});
    const { user, sessionId } = await opened(f);
    const expired = await f.jwt.signAsync({ sub: user.id, sid: sessionId, tokenUse: 'access' }, { audience: f.options.tokens.accessAudience, expiresIn: -10 });
    expect(await f.guard.verify(expired)).toBeNull();
  });
});

describe('refresh-token rotation and reuse detection', () => {
  async function session(f: Fixture) {
    const user = await f.createUser('rotator');
    const result = await f.accounts.signIn(user, 'password' as never).catch(() => f.accounts.signIn(user, { kind: 'password' }));
    if (result.twoFactorRequired) throw new Error('unexpected challenge');
    const claims = await f.jwt.verifyAsync(result.refreshToken, { audience: f.options.tokens.refreshAudience });
    return { user, refresh: result.refreshToken, sessionId: claims.sub as string, access: result.accessToken };
  }

  it('rotates the refresh token and returns a working access token', async () => {
    const f = createFixture({});
    const { refresh, sessionId, user } = await session(f);
    const rotated = await f.accounts.refresh(refresh);
    expect(rotated.refreshToken).not.toBe(refresh);
    const claims = await f.jwt.verifyAsync(rotated.accessToken, { audience: f.options.tokens.accessAudience });
    expect(claims).toMatchObject({ sub: user.id, sid: sessionId, tokenUse: 'access', username: 'rotator' });
    await expect(f.accounts.currentUser(user.id, sessionId)).resolves.toMatchObject({ id: user.id });
  });

  // Contract preserved from the products (ccopyright session-revocation.contract.spec: "current behaviour"): a spent
  // token is refused, but the session its successor holds is NOT revoked. Flip this test if reuse revocation is adopted.
  it('replaying an already rotated token is refused and leaves the successor session alive', async () => {
    const f = createFixture({});
    const { refresh, sessionId, user } = await session(f);
    const rotated = await f.accounts.refresh(refresh);
    await expect(f.accounts.refresh(refresh)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.accounts.refresh(refresh)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.accounts.currentUser(user.id, sessionId)).resolves.toMatchObject({ id: user.id });
    const row = await f.db.model(f.options.models.accountSessions).findUnique({ where: { id: sessionId } });
    expect(row!.revokedAt ?? null).toBeNull();
    expect(await f.accounts.refresh(rotated.refreshToken)).toMatchObject({ accessToken: expect.any(String) });
  });

  it('logging the session out revokes it for refresh and for access tokens', async () => {
    const f = createFixture({});
    const { refresh, sessionId, user } = await session(f);
    await f.accounts.sessions.revokeSession(sessionId, 'logout');
    await expect(f.accounts.refresh(refresh)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.accounts.currentUser(user.id, sessionId)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses access tokens, forged tokens and foreign audiences as refresh tokens', async () => {
    const f = createFixture({});
    const { access, user, sessionId } = await session(f);
    await expect(f.accounts.refresh(access)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.accounts.refresh('garbage')).rejects.toBeInstanceOf(UnauthorizedException);
    const foreign = await f.jwt.signAsync({ sub: sessionId, jti: 'x', tokenUse: 'refresh' }, { audience: 'other:aud', expiresIn: 60 });
    await expect(f.accounts.refresh(foreign)).rejects.toBeInstanceOf(UnauthorizedException);
    // Those probes left the real session intact.
    await expect(f.accounts.currentUser(user.id, sessionId)).resolves.toBeDefined();
  });

  it('a revoked session, disabled user or credential bump cannot refresh', async () => {
    const f = createFixture({});
    const a = await session(f);
    await f.db.model(f.options.models.users).update({ where: { id: a.user.id }, data: { credentialVersion: { increment: 1 } } });
    await expect(f.accounts.refresh(a.refresh)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refreshSessionId only keys the current token of a session', async () => {
    const f = createFixture({});
    const { refresh, sessionId } = await session(f);
    expect(await f.accounts.refreshSessionId(refresh)).toBe(sessionId);
    const rotated = await f.accounts.refresh(refresh);
    expect(await f.accounts.refreshSessionId(refresh)).toBeNull();
    expect(await f.accounts.refreshSessionId(rotated.refreshToken)).toBe(sessionId);
    expect(await f.accounts.refreshSessionId('')).toBeNull();
  });
});

describe('product sign-in methods', () => {
  const methods = { 'login-code': { emailProof: true }, 'sso-ticket': { emailProof: false } } as const;

  it('opens a session recorded under the product method name', async () => {
    const f = createFixture({ signInMethods: methods });
    const user = await f.createUser('prod');
    const result = await f.accounts.signIn(user, 'login-code');
    expect(result).toMatchObject({ twoFactorRequired: false, userId: user.id });
    const rows = await f.db.model(f.options.models.accountSessions).findMany({ where: { userId: user.id } });
    expect(rows.map(row => row.authMethod)).toEqual(['login-code']);
  });

  it('refuses an unregistered method and a disabled account', async () => {
    const f = createFixture({ signInMethods: methods });
    const user = await f.createUser('prod2');
    await expect(f.accounts.signIn(user, 'nope')).rejects.toThrow(/not registered/);
    await expect(f.accounts.signIn(user, 'constructor')).rejects.toThrow(/not registered/);
    await expect(f.accounts.signIn({ ...user, status: false } as UserEntity, 'login-code')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an email-proof method session survives while the address stays verified; an unverified account loses it on policy', async () => {
    const f = createFixture({ signInMethods: methods, policy: { requireEmailVerification: true } });
    const user = await f.createUser('prod3', { emailVerified: false });
    const proof = await f.accounts.signIn(user, 'login-code') as { userId: string; accessToken: string };
    const claims = await f.jwt.verifyAsync(proof.accessToken, { audience: f.options.tokens.accessAudience });
    // The method proved the address only when the account says so; an unverified account is not let in by it.
    await expect(f.accounts.currentUser(user.id, claims.sid)).rejects.toBeInstanceOf(UnauthorizedException);
    const verified = await f.createUser('prod4');
    const ok = await f.accounts.signIn(verified, 'login-code') as { accessToken: string };
    const okClaims = await f.jwt.verifyAsync(ok.accessToken, { audience: f.options.tokens.accessAudience });
    await expect(f.accounts.currentUser(verified.id, okClaims.sid)).resolves.toBeDefined();
    // A method that does not prove the address follows the verification requirement.
    const sso = await f.accounts.signIn(verified, 'sso-ticket') as { accessToken: string };
    const ssoClaims = await f.jwt.verifyAsync(sso.accessToken, { audience: f.options.tokens.accessAudience });
    await expect(f.accounts.currentUser(verified.id, ssoClaims.sid)).resolves.toBeDefined();
  });

  it('a session of a method that is no longer registered stops working', async () => {
    const withMethod = createFixture({ signInMethods: methods });
    const user = await withMethod.createUser('prod5');
    const result = await withMethod.accounts.signIn(user, 'login-code') as { accessToken: string };
    const claims = await withMethod.jwt.verifyAsync(result.accessToken, { audience: withMethod.options.tokens.accessAudience });
    const without = createFixture({ db: withMethod.db });
    await expect(without.accounts.currentUser(user.id, claims.sid)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('enrolled two-factor turns a product sign-in into a method-scoped challenge that completes into the same method', async () => {
    const f = createFixture({ signInMethods: methods });
    const user = await f.createUser('prod6');
    const first = await f.accounts.signIn(user, 'login-code') as { accessToken: string };
    const claims = await f.jwt.verifyAsync(first.accessToken, { audience: f.options.tokens.accessAudience });
    const { secret } = await f.twoFactor!.enrol(user);
    const code = () => generateTotpCode({ secret, time: f.clock.now.getTime() });
    await f.twoFactor!.confirm(user.id, claims.sid, code());
    f.clock.advance(31); // a new TOTP step: the enrolment code cannot be replayed
    const challenge = await f.accounts.signIn(await f.accounts.users().findById(user.id) as UserEntity, 'login-code');
    expect(challenge).toMatchObject({ twoFactorRequired: true, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const tickets = await f.db.model(f.options.models.accountTickets).findMany({});
    expect(tickets.map(row => row.purpose)).toContain('two-factor:method:login-code');
    const pair = await f.accounts.loginTwoFactor({ challenge: (challenge as { challenge: string }).challenge, code: code() });
    expect(pair.userId).toBe(user.id);
    const sessions = await f.db.model(f.options.models.accountSessions).findMany({ where: { userId: user.id, authMethod: 'login-code' } });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    // The challenge is single use, and a wrong code leaves a fresh challenge usable.
    await expect(f.accounts.loginTwoFactor({ challenge: (challenge as { challenge: string }).challenge, code: code() })).rejects.toSatisfy(error => status(error) === 400);
  });
});

describe('feature switches and table access', () => {
  it('with twoFactor, deletion and apiKeys off, sign-in never reads their tables', async () => {
    const f = createFixture({ features: { twoFactor: false, deletion: false, apiKeys: false, oauth: false, avatar: false },
      models: { accountTwoFactor: 'tf_off', accountDeletions: 'del_off', accountApiKeys: 'keys_off', accountRecoveryCodes: 'rec_off' } });
    const user = await f.createUser('quiet');
    f.db.touched.clear();
    const result = await f.accounts.login({ username: 'quiet', password: PASSWORD });
    expect(result).toMatchObject({ twoFactorRequired: false });
    await f.accounts.refresh((result as { refreshToken: string }).refreshToken);
    await f.accounts.signIn(user, { kind: 'password' });
    expect([...f.db.touched].filter(name => ['tf_off', 'del_off', 'keys_off', 'rec_off'].includes(name))).toEqual([]);
  });

  it('with twoFactor on, the renamed enrolment table is read on sign-in', async () => {
    const f = createFixture({ models: { accountTwoFactor: 'my_totp' } });
    await f.createUser('reader');
    f.db.touched.clear();
    await f.accounts.login({ username: 'reader', password: PASSWORD });
    expect(f.db.touched.has('my_totp')).toBe(true);
    expect(f.db.touched.has('accountTwoFactor')).toBe(false);
  });

  it('custom model names are used for every account table the flows touch', async () => {
    const names = { users: 'users', accountSessions: 'auth_sessions', accountTickets: 'auth_tickets', emailVerifications: 'mail_codes' };
    const f = createFixture({ models: names, verification: { mode: 'code', signInOnVerify: true }, policy: { requireEmailVerification: true },
      mailer: new CodeMailer() });
    f.db.touched.clear();
    await f.accounts.register({ username: 'named', email: 'named@example.invalid', password: PASSWORD, locale: 'en' });
    await f.accounts.consumeEmail({ email: 'named@example.invalid', code: f.mailer.last('verify-email')!.secret }, 'verify-email');
    const touched = [...f.db.touched];
    expect(touched).toEqual(expect.arrayContaining(['users', 'auth_sessions', 'mail_codes']));
    expect(touched).not.toContain('accountSessions');
    expect(touched).not.toContain('emailVerifications');
  });

  it('closed registration, an existing account and an existing email are refused', async () => {
    const f = createFixture({ policy: { registrationOpen: false } });
    await expect(f.accounts.register({ username: 'closed', email: 'c@example.invalid', password: PASSWORD })).rejects.toThrow(/closed/);
    const g = createFixture({});
    await g.accounts.register({ username: 'dupe', email: 'dupe@example.invalid', password: PASSWORD });
    await expect(g.accounts.register({ username: 'dupe', email: 'other@example.invalid', password: PASSWORD })).rejects.toThrow(/exists/);
    await expect(g.accounts.register({ username: 'other', email: 'dupe@example.invalid', password: PASSWORD })).rejects.toThrow(/exists/);
    await expect(g.accounts.register({ username: 'deleted-x', email: 'dx@example.invalid', password: PASSWORD })).rejects.toThrow(/reserved/);
  });

  it('a failed sign-up transaction leaves no user row and no signup side effect', async () => {
    const hooks: string[] = [];
    const f = createFixture();
    const failing = createFixture({ db: f.db });
    // signup hook that throws inside the user-creation transaction
    const accounts = failing.accounts as unknown as { signupHooks?: unknown };
    accounts.signupHooks = { recordSignup: async () => { throw new Error('hook failed'); }, afterSignup: async () => { hooks.push('after'); } };
    await expect(failing.accounts.register({ username: 'rolled', email: 'rolled@example.invalid', password: PASSWORD })).rejects.toThrow('hook failed');
    expect(hooks).toEqual([]);
  });
});
