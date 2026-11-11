// @vitest-environment node
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { generateTotpCode, ScryptEncoder, type UserEntity } from '@zucker-framework/auth';
import { ACCOUNT_LOGIN_IDENTIFIER_FIELDS, createAccountController, loginAccountKey, resolveAccountsOptions, type BackOfficeAccountsOptions } from './index';
import { CodeMailer, PASSWORD, createFixture, type Fixture } from './testing/account-fixture';

const bad = (input: unknown, message: RegExp) => expect(() => resolveAccountsOptions(input as BackOfficeAccountsOptions)).toThrowError(message);

/** Counts hash comparisons, so every miss can be shown to cost exactly one (dummy) comparison. */
function countingEncoder() {
  const encoder = new ScryptEncoder();
  const counts = { encode: 0, matches: 0 };
  return {
    counts,
    encode: async (raw: string) => { counts.encode += 1; return encoder.encode(raw); },
    matches: async (raw: string, hash: string) => { counts.matches += 1; return encoder.matches(raw, hash); },
  };
}

describe('login identifier option', () => {
  it('defaults to username and validates the option', () => {
    expect(resolveAccountsOptions().login).toEqual({ identifier: 'username', field: 'username' });
    expect(resolveAccountsOptions({ login: { identifier: 'email' } }).login).toEqual({ identifier: 'email', field: 'email' });
    expect(resolveAccountsOptions({ login: { identifier: 'username-or-email' } }).login).toEqual({ identifier: 'username-or-email', field: 'login' });
    expect(Object.isFrozen(resolveAccountsOptions().login)).toBe(true);
    expect(ACCOUNT_LOGIN_IDENTIFIER_FIELDS).toEqual({ username: 'username', email: 'email', 'username-or-email': 'login' });
    bad({ login: { identifier: 'phone' } }, /login\.identifier/);
    bad({ login: { identifier: 'constructor' } }, /login\.identifier/);
    bad({ login: 'email' }, /login must be an object/);
  });

  it('signup.typeId defaults to member and is validated', () => {
    expect(resolveAccountsOptions().signup).toEqual({ typeId: 'member' });
    expect(resolveAccountsOptions({ signup: { typeId: 'user' } }).signup).toEqual({ typeId: 'user' });
    bad({ signup: { typeId: '' } }, /signup\.typeId/);
    bad({ signup: { typeId: 'has space' } }, /signup\.typeId/);
    bad({ signup: [] }, /signup must be an object/);
  });

  it('keys the login budgets on the normalized identifier field of the option', () => {
    expect(loginAccountKey({ username: ' Alice ' })).toBe('alice');
    expect(loginAccountKey({ email: 'Alice@Example.Invalid' })).toBeUndefined();
    expect(loginAccountKey({ email: ' Alice@Example.Invalid ' }, 'email')).toBe('alice@example.invalid');
    expect(loginAccountKey({ username: 'alice' }, 'email')).toBeUndefined();
    expect(loginAccountKey({ login: 'ALICE@example.invalid' }, 'username-or-email')).toBe('alice@example.invalid');
    expect(loginAccountKey({ login: 'x'.repeat(257) }, 'username-or-email')).toBeUndefined();
    expect(loginAccountKey({ login: 42 }, 'username-or-email')).toBeUndefined();
  });
});

describe('password sign-in by e-mail', () => {
  const emailFixture = (extra: Parameters<typeof createFixture>[0] = {}) => createFixture({ login: { identifier: 'email' }, ...extra });

  it('signs in by a case/whitespace variant of the address and refuses the username field', async () => {
    const f = emailFixture();
    const user = await f.createUser('mailer1', { email: 'mailer1@example.invalid' });
    expect(await f.accounts.login({ email: '  MAILER1@Example.Invalid ', password: PASSWORD })).toMatchObject({ twoFactorRequired: false, userId: user.id });
    await expect(f.accounts.login({ username: 'mailer1', password: PASSWORD })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.accounts.login({ email: '', password: PASSWORD })).rejects.toBeInstanceOf(BadRequestException);
    // The username is not an address: a miss, not a different error.
    await expect(f.accounts.login({ email: 'mailer1', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers the same 401 with one hash comparison for every kind of miss', async () => {
    const encoder = countingEncoder();
    const f = emailFixture({ encoder });
    await f.createUser('known1', { email: 'known1@example.invalid' });
    await f.accounts.users().addUser({ username: 'nopass', email: 'nopass@example.invalid', typeId: 'member', status: true, emailVerified: true },
      { passwordless: true });
    await f.createUser('off1', { email: 'off1@example.invalid', status: false });
    const misses = [
      { email: 'ghost@example.invalid', password: PASSWORD },
      { email: 'not-an-address', password: PASSWORD },
      { email: 'known1@example.invalid', password: `${PASSWORD}x` },
      { email: 'nopass@example.invalid', password: PASSWORD },
      { email: 'off1@example.invalid', password: PASSWORD },
    ];
    for (const body of misses) {
      const before = encoder.counts.matches;
      const error = await f.accounts.login(body).catch(caught => caught);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe('Invalid credentials or email not verified');
      expect(encoder.counts.matches - before).toBe(1);
    }
  });

  it('an address shared by several (legacy) rows signs nobody in', async () => {
    const f = emailFixture();
    await f.createUser('dup1', { email: 'dup@example.invalid' });
    await f.createUser('dup2', { email: 'dup@example.invalid' });
    await expect(f.accounts.login({ email: 'dup@example.invalid', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('enrolled two-factor turns an e-mail sign-in into a password challenge', async () => {
    const f = emailFixture();
    const user = await f.createUser('tf1', { email: 'tf1@example.invalid' });
    const first = await f.accounts.login({ email: 'tf1@example.invalid', password: PASSWORD }) as { accessToken: string };
    const claims = await f.jwt.verifyAsync(first.accessToken, { audience: f.options.tokens.accessAudience });
    const { secret } = await f.twoFactor!.enrol(user);
    const code = () => generateTotpCode({ secret, time: f.clock.now.getTime() });
    await f.twoFactor!.confirm(user.id, claims.sid, code());
    f.clock.advance(31);
    const challenge = await f.accounts.login({ email: 'TF1@example.invalid', password: PASSWORD });
    expect(challenge).toMatchObject({ twoFactorRequired: true, challenge: expect.any(String) });
    expect(await f.accounts.twoFactorChallengeSubject({ challenge: (challenge as { challenge: string }).challenge, code: '000000' })).toBe(user.id);
    const pair = await f.accounts.loginTwoFactor({ challenge: (challenge as { challenge: string }).challenge, code: code() });
    expect(pair.userId).toBe(user.id);
  });

  it('in code mode an unverified address cannot sign in until its code is consumed', async () => {
    const f = emailFixture({ verification: { mode: 'code', signInOnVerify: false }, mailer: new CodeMailer(), policy: { requireEmailVerification: true } });
    expect(await f.accounts.register({ username: 'coder1', email: 'Coder1@Example.invalid', password: PASSWORD, locale: 'en' }))
      .toEqual({ verificationRequired: true });
    await expect(f.accounts.login({ email: 'coder1@example.invalid', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
    const mail = f.mailer.last('verify-email')!;
    await f.accounts.consumeEmail({ email: 'coder1@example.invalid', code: mail.secret }, 'verify-email');
    expect(await f.accounts.login({ email: 'CODER1@example.invalid', password: PASSWORD })).toMatchObject({ twoFactorRequired: false });
  });

  it('access tokens of an e-mail sign-in pass the guard with additional (legacy) verifiers configured', async () => {
    const probe = { calls: 0, verify: async () => { probe.calls += 1; return null; } };
    const f = emailFixture({ tokens: { additionalAccessVerifiers: [probe] } });
    await f.createUser('legacy1', { email: 'legacy1@example.invalid' });
    const result = await f.accounts.login({ email: 'legacy1@example.invalid', password: PASSWORD }) as { accessToken: string };
    expect(await f.guard.verify(result.accessToken)).toMatchObject({ sessionId: expect.any(String) });
    expect(probe.calls).toBe(0);
  });
});

describe('password sign-in by username or e-mail', () => {
  const either = (extra: Parameters<typeof createFixture>[0] = {}) => createFixture({ login: { identifier: 'username-or-email' }, ...extra });

  it('accepts the username (exact) or the address in the login field', async () => {
    const f = either();
    const user = await f.createUser('both1', { email: 'both1@example.invalid' });
    expect(await f.accounts.login({ login: 'both1', password: PASSWORD })).toMatchObject({ userId: user.id });
    expect(await f.accounts.login({ login: 'Both1@Example.invalid', password: PASSWORD })).toMatchObject({ userId: user.id });
    await expect(f.accounts.login({ username: 'both1', password: PASSWORD })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.accounts.login({ login: 'BOTH1', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an exact username match wins over another account whose address is the same text', async () => {
    const f = either();
    const named = await f.createUser('shared@example.invalid', { email: 'named@example.invalid' });
    await f.createUser('other1', { email: 'shared@example.invalid', password: 'Different!Passw0rd#9' } as Partial<UserEntity>);
    expect(await f.accounts.login({ login: 'shared@example.invalid', password: PASSWORD })).toMatchObject({ userId: named.id });
    await expect(f.accounts.login({ login: 'shared@example.invalid', password: 'Different!Passw0rd#9' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('misses cost one comparison in both lookup shapes', async () => {
    const encoder = countingEncoder();
    const f = either({ encoder });
    for (const login of ['nobody', 'nobody@example.invalid']) {
      const before = encoder.counts.matches;
      await expect(f.accounts.login({ login, password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(encoder.counts.matches - before).toBe(1);
    }
  });
});

describe('username identifier (default) is unchanged', () => {
  it('still signs in by exact username only', async () => {
    const f: Fixture = createFixture();
    const user = await f.createUser('plain1');
    expect(await f.accounts.login({ username: 'plain1', password: PASSWORD })).toMatchObject({ userId: user.id });
    await expect(f.accounts.login({ email: 'plain1@example.invalid', password: PASSWORD })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.accounts.login({ username: 'plain1@example.invalid', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await f.accounts.verifyPassword('plain1', PASSWORD)).toMatchObject({ id: user.id });
    expect(await f.accounts.verifyPassword('plain1', PASSWORD)).not.toHaveProperty('password');
  });
});

describe('signup.typeId', () => {
  it('register writes the configured type (default member)', async () => {
    const f = createFixture({ signup: { typeId: 'user' }, policy: { requireEmailVerification: false } });
    await f.accounts.register({ username: 'typed1', email: 'typed1@example.invalid', password: PASSWORD, locale: 'en' });
    expect((await f.accounts.users().findByUsername('typed1'))!.typeId).toBe('user');
    const d = createFixture({ policy: { requireEmailVerification: false } });
    await d.accounts.register({ username: 'typed2', email: 'typed2@example.invalid', password: PASSWORD, locale: 'en' });
    expect((await d.accounts.users().findByUsername('typed2'))!.typeId).toBe('member');
  });
});

describe('login route budgets', () => {
  it('spend the per-account budgets on the normalized address in e-mail mode', async () => {
    const options = resolveAccountsOptions({ login: { identifier: 'email' }, origins: ['https://app.example.invalid'] });
    const consumed: string[] = [];
    const limiter = { has: () => true, consume: async (name: string, key: string) => { consumed.push(`${name}|${key}`); }, reward: async () => undefined };
    const accounts = { login: async () => ({ twoFactorRequired: true, challenge: 'c' }) };
    const Controller = createAccountController();
    const controller = new (Controller as new (...args: unknown[]) => { login(body: unknown, req: unknown, res: unknown): Promise<unknown> })(
      accounts, {}, limiter, options);
    await controller.login({ email: ' Who@Example.Invalid ', password: PASSWORD }, { ip: '203.0.113.9', headers: { origin: 'https://app.example.invalid' } }, {});
    expect(consumed).toEqual(['login|login:who@example.invalid:203.0.113.9', 'login-account|login-account:who@example.invalid']);
  });
});
