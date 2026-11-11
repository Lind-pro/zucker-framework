import assert from 'node:assert/strict';
import { test } from 'node:test';

const flow = await import('./sign-in-flow.ts');
const scopes = await import('../../app/[locale]/account/_components/api-key-scopes.ts');

const challenge = 'c'.repeat(43);
const failure = (status, code, details) => Object.assign(new Error('x'), {
  status, ...(code ? { code } : {}), response: { status, data: { status, code, message: 'x', result: { reason: code, ...(details ? { details } : {}) } } },
});

test('signInResult distinguishes a session from the two-factor step and rejects anything else', () => {
  assert.deepEqual(flow.signInResult({ userId: 'u', token: 'access', expires: 1 }), { kind: 'session', token: 'access', returnPath: undefined });
  assert.deepEqual(flow.signInResult({ twoFactorRequired: true, challenge, returnPath: '/pricing' }), { kind: 'two-factor', challenge, returnPath: '/pricing' });
  for (const value of [null, {}, { token: '' }, { twoFactorRequired: true }, { twoFactorRequired: true, challenge: 'short' }, { twoFactorRequired: 'true', challenge }])
    assert.throws(() => flow.signInResult(value), /Unexpected sign-in response/);
});

test('two-factor login body carries exactly one factor', () => {
  assert.deepEqual(flow.twoFactorLoginBody(challenge, 'code', ' 123 456 '), { challenge, code: '123456' });
  assert.deepEqual(flow.twoFactorLoginBody(challenge, 'recovery', ' abcde-fghjk '), { challenge, recoveryCode: 'abcde-fghjk' });
  assert.equal(flow.twoFactorLoginBody(challenge, 'code', '12345'), null);
  assert.equal(flow.twoFactorLoginBody(challenge, 'code', 'abcdef'), null);
  assert.equal(flow.twoFactorLoginBody(challenge, 'recovery', 'abc'), null);
  assert.equal(flow.twoFactorLoginBody('bad', 'code', '123456'), null);
  assert.deepEqual(flow.factorBody('code', '123456', ''), { code: '123456' });
  assert.deepEqual(flow.factorBody('recovery', 'abcde fghjk', 'pw'), { password: 'pw', recoveryCode: 'abcde fghjk' });
  assert.equal(flow.factorBody('code', 'nope', 'pw'), null);
});

test('only documented codes are trusted', () => {
  assert.deepEqual(flow.securityFailure(failure(401, 'TWO_FACTOR_CODE_INVALID')), { status: 401, code: 'TWO_FACTOR_CODE_INVALID' });
  assert.deepEqual(flow.securityFailure(failure(400, 'SOMETHING_ELSE')), { status: 400, code: undefined });
  assert.deepEqual(flow.securityFailure(null), { status: undefined, code: undefined });
  assert.equal(flow.twoFactorStepFailure(failure(400, 'TWO_FACTOR_CHALLENGE_INVALID')), 'restart');
  assert.equal(flow.twoFactorStepFailure(failure(401, 'TWO_FACTOR_CODE_INVALID')), 'codeInvalid');
  assert.equal(flow.twoFactorStepFailure(failure(429)), 'tooManyRequests');
  assert.equal(flow.twoFactorStepFailure(failure(503, 'TWO_FACTOR_UNAVAILABLE')), 'unavailable');
  assert.equal(flow.twoFactorSettingsFailure(failure(403, 'RECENT_AUTHENTICATION_REQUIRED')), 'recentRequired');
  assert.equal(flow.twoFactorSettingsFailure(failure(403, 'RECENT_AUTHENTICATION_FAILED')), 'recentFailed');
  assert.equal(flow.twoFactorSettingsFailure(failure(500)), 'failed');
  assert.equal(flow.deletionFailure(failure(409, 'ACCOUNT_HAS_ACTIVE_SUBSCRIPTION')), 'activeSubscription');
  assert.equal(flow.deletionFailure(failure(409, 'ACCOUNT_LAST_SUPERADMIN')), 'lastSuperadmin');
  assert.equal(flow.deletionFailure(failure(400, 'ACCOUNT_DELETION_CONFIRM_MISMATCH')), 'mismatch');
});

test('deletion pending is read from the envelope details', () => {
  const at = '2026-11-17T10:00:00.000Z';
  assert.equal(flow.deletionPendingUntil(failure(403, 'ACCOUNT_DELETION_PENDING', { executeAfter: at })), at);
  assert.equal(flow.deletionPendingUntil(Object.assign(new Error('x'), { status: 403, code: 'ACCOUNT_DELETION_PENDING', details: { executeAfter: at } })), at);
  assert.equal(flow.deletionPendingUntil(failure(403, 'ACCOUNT_DELETION_PENDING', { executeAfter: 'soon' })), '');
  assert.equal(flow.deletionPendingUntil(failure(403, 'MAGIC_LINK_DISABLED')), null);
});

test('login step reducer', () => {
  const start = { step: 'credentials' };
  assert.deepEqual(flow.loginStep(start, { type: 'result', result: { kind: 'two-factor', challenge } }), { step: 'two-factor', challenge });
  assert.deepEqual(flow.loginStep(start, { type: 'result', result: { kind: 'session', token: 't' } }), start);
  assert.deepEqual(flow.loginStep(start, { type: 'failure', error: failure(403, 'ACCOUNT_DELETION_PENDING', { executeAfter: '2026-11-17T10:00:00Z' }) }),
    { step: 'deletion-pending', executeAfter: '2026-11-17T10:00:00Z' });
  assert.equal(flow.loginStep(start, { type: 'failure', error: failure(401) }), start);
  assert.deepEqual(flow.loginStep({ step: 'two-factor', challenge }, { type: 'restart' }), start);
});

test('public account policy falls back to server defaults', () => {
  assert.deepEqual(flow.accountSecurityPolicy(null), flow.DEFAULT_ACCOUNT_SECURITY_POLICY);
  assert.deepEqual(flow.accountSecurityPolicy({ policies: { account: { values: { magicLinkEnabled: true, deletionEnabled: false, deletionGraceDays: 14, twoFactorEnabled: 'no' } } } }),
    { twoFactorEnabled: true, magicLinkEnabled: true, deletionEnabled: false, deletionGraceDays: 14 });
  assert.equal(flow.accountSecurityPolicy({ policies: { account: { values: { deletionGraceDays: 61 } } } }).deletionGraceDays, 7);
});

test('fragment tickets and popup start parameters', () => {
  const ticket = 't'.repeat(43);
  assert.equal(flow.fragmentTicket(`#ticket=${ticket}`, 'ticket'), ticket);
  assert.equal(flow.fragmentTicket(`#cancel-deletion=${ticket}`, 'cancel-deletion'), ticket);
  assert.equal(flow.fragmentTicket(`#cancel-deletion=${ticket}`, 'ticket'), '');
  assert.equal(flow.fragmentTicket('#ticket=short', 'ticket'), '');
  const state = flow.newPopupState();
  assert.match(state, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(state, flow.newPopupState());
  assert.equal(flow.newPopupState(bytes => bytes.fill(255)), '_'.repeat(32));
  const fragment = flow.popupStartFragment('github', state, '/billing/subscriptions?x=1');
  assert.deepEqual(flow.parsePopupStart(`#${fragment}`), { provider: 'github', state, returnPath: '/billing/subscriptions?x=1' });
  assert.equal(flow.parsePopupStart(`#provider=evil&state=${state}`), null);
  assert.equal(flow.parsePopupStart('#provider=google&state=short'), null);
  assert.equal(flow.parsePopupStart(`#provider=google&state=${state}&returnPath=//evil.example`), null);
  assert.equal(flow.parsePopupStart(`#provider=google&state=${state}&returnPath=https://evil.example`), null);
  assert.equal(flow.isPopupState(state), true);
  assert.equal(flow.isPopupState(null), false);
  assert.equal(flow.popupFailureKey('oauthExpired'), 'oauthExpired');
  assert.equal(flow.popupFailureKey('<script>'), 'oauthFailed');
});

test('otpauth URI, secret grouping and recovery-code file', () => {
  const uri = 'otpauth://totp/Acme:user%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30';
  assert.equal(flow.safeOtpauthUri(uri), uri);
  for (const value of ['javascript:alert(1)', 'otpauth://hotp/x?secret=A', 'otpauth://totp/a b', 42]) assert.equal(flow.safeOtpauthUri(value), null);
  assert.equal(flow.groupSecret('JBSWY3DPEHPK3PXP'), 'JBSW Y3DP EHPK 3PXP');
  const file = flow.recoveryCodesFile(['aaaaa-bbbbb', 'ccccc-ddddd'], 'synthetic', new Date('2026-11-10T00:00:00Z'));
  assert.match(file, /^Recovery codes for synthetic\nIssued 2026-11-10T00:00:00.000Z\n/);
  assert.ok(file.includes('aaaaa-bbbbb\nccccc-ddddd\n'));
});

test('API-key scope selection keeps account:read and makes ai:generate opt-in', () => {
  assert.deepEqual(scopes.selectedApiKeyScopes(false), ['account:read']);
  assert.deepEqual(scopes.selectedApiKeyScopes(true), ['account:read', 'ai:generate']);
  assert.deepEqual(scopes.displayApiKeyScopes(['ai:generate', 'custom', 'account:read', 5, '']), ['account:read', 'ai:generate', 'custom']);
  assert.deepEqual(scopes.displayApiKeyScopes(undefined), []);
});
