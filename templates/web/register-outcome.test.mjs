import assert from 'node:assert/strict';
import { test } from 'node:test';

// account-flow.ts has no imports, so Node's type stripping loads it directly.
const { registerOutcome } = await import('./src/app/[locale]/account/_components/account-flow.ts');

test('verification on: the page shows the "check your mail" state', () => {
  assert.deepEqual(registerOutcome({ verificationRequired: true }), { kind: 'verify' });
});

test('verification off: the issued access token completes sign-in instead of failing', () => {
  assert.deepEqual(registerOutcome({ verificationRequired: false, userId: 'u1', token: 'access-token', expires: 900 }),
    { kind: 'signed-in', token: 'access-token' });
});

test('anything else is an unexpected response', () => {
  for (const value of [null, undefined, {}, { verificationRequired: false }, { verificationRequired: false, token: '' },
    { verificationRequired: false, token: 5 }, { verificationRequired: 'true' }, 'ok'])
    assert.throws(() => registerOutcome(value), /Unexpected account response/);
});
