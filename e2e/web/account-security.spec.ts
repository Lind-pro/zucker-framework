/** /account/security (two-step verification, recent-authentication failures, account deletion) and the API-key scope on /account. Synthetic API only. */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { bodyOf, count, fail, identity, installApi, ok, signedIn, storedToken, type ApiCall } from './account-security-fixtures';

const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const otpauth = `otpauth://totp/Synthetic:synthetic?secret=${secret}&issuer=Synthetic`;
const recoveryCodes = Array.from({ length: 10 }, (_, index) => `aaaa${index}-bbbbb`);
type Status = { available: boolean; status: 'off' | 'pending' | 'active'; confirmedAt: string | null; recoveryCodesRemaining: number; enrolmentAllowed: boolean };
const off: Status = { available: true, status: 'off', confirmedAt: null, recoveryCodesRemaining: 0, enrolmentAllowed: true };
const active: Status = { available: true, status: 'active', confirmedAt: '2026-11-10T10:00:00Z', recoveryCodesRemaining: 7, enrolmentAllowed: true };

/** Mocks for the security page; `extra` answers anything else first. */
async function securityPage(page: Page, context: BrowserContext, baseURL: string, options: {
  status?: () => Status; policy?: object; extra?: Parameters<typeof installApi>[2]; locale?: string;
} = {}): Promise<ApiCall[]> {
  const calls = await installApi(context, baseURL, (route, path, body, method) => {
    const handled = options.extra?.(route, path, body, method);
    if (handled !== undefined) return handled;
    if (path === '/site/public/config') return ok(route, { policies: { account: { values: options.policy ?? { deletionEnabled: true, deletionGraceDays: 14 } } } });
    if (path === '/authorize/me') return ok(route, identity);
    if (path === '/authorize/sessions') return ok(route, []);
    if (path === '/authorize/two-factor/status') return ok(route, (options.status ?? (() => off))());
  });
  await signedIn(page, context, baseURL, options.locale);
  await page.goto(`/${options.locale ?? 'en'}/account/security`);
  return calls;
}

test.describe('two-step verification', () => {
  test('enrol with the password, scan or copy the key, confirm, save the recovery codes once', async ({ page, context, baseURL }) => {
    let status = off;
    const calls = await securityPage(page, context, baseURL!, { status: () => status, extra: (route, path) => {
      if (path === '/authorize/two-factor/enrol') return ok(route, { secret, otpauthUri: otpauth });
      if (path === '/authorize/two-factor/confirm') { status = { ...active, recoveryCodesRemaining: 10 }; return ok(route, { recoveryCodes }); }
    } });
    await page.getByRole('button', { name: 'Set up two-step verification' }).click();
    await page.locator('#two-factor-enrol-password').fill('Synthetic123');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('#two-factor-secret')).toHaveValue('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    expect(await page.getByRole('link', { name: 'Open in authenticator app' }).getAttribute('href')).toMatch(/^otpauth:\/\/totp\//);
    await page.getByLabel('Code from the app').fill('123 456');
    await page.getByRole('button', { name: 'Turn on' }).click();
    const list = page.getByRole('list', { name: 'Your recovery codes' });
    await expect(list.getByText('aaaa9-bbbbb')).toBeVisible();
    await expect(page.getByText('On since')).toBeVisible();
    expect(bodyOf(calls, '/authorize/two-factor/enrol')).toEqual({ password: 'Synthetic123' });
    expect(bodyOf(calls, '/authorize/two-factor/confirm')).toEqual({ code: '123456' });
    await page.getByRole('button', { name: 'I have saved them' }).click();
    await expect(page.getByText('aaaa9-bbbbb')).toHaveCount(0);
    // Reloading never shows the codes again; only the count is known.
    await page.reload();
    await expect(page.getByText('10 recovery codes left')).toBeVisible();
    await expect(page.getByText('aaaa0-bbbbb')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('aaaa0-bbbbb');
  });

  test('a non-numeric confirmation code is refused before any request; a wrong code is explained', async ({ page, context, baseURL }) => {
    const calls = await securityPage(page, context, baseURL!, { extra: (route, path) => {
      if (path === '/authorize/two-factor/enrol') return ok(route, { secret, otpauthUri: otpauth });
      // Account endpoints answer 400 (401 is the login step only), so a wrong code never looks like an expired session.
      if (path === '/authorize/two-factor/confirm') return fail(route, 400, 'TWO_FACTOR_CODE_INVALID');
    } });
    await page.getByRole('button', { name: 'Set up two-step verification' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    expect(bodyOf(calls, '/authorize/two-factor/enrol')).toEqual({});
    await page.getByLabel('Code from the app').fill('12ab');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByText('That code is not valid.')).toBeVisible();
    expect(count(calls, '/authorize/two-factor/confirm')).toBe(0);
    await page.getByLabel('Code from the app').fill('123456');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByText('That code is not valid.')).toBeVisible();
    expect(count(calls, '/authorize/two-factor/confirm')).toBe(1);
    expect(await storedToken(page)).toBe('access'); // a wrong code never ends the session
  });

  test('unavailable and paused enrolment are explained instead of offering the button', async ({ page, context, baseURL }) => {
    let status: Status = { ...off, available: false };
    await securityPage(page, context, baseURL!, { status: () => status });
    await expect(page.getByText('Two-step verification is not available on this server yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up two-step verification' })).toHaveCount(0);
    status = { ...off, enrolmentAllowed: false };
    await page.reload();
    await expect(page.getByText('New two-step enrolments are turned off.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up two-step verification' })).toHaveCount(0);
  });

  test('a failing status request offers a retry', async ({ page, context, baseURL }) => {
    // Fail until Retry is pressed: React Strict Mode (dev) runs the load effect twice and drops the first result.
    let failing = true;
    await securityPage(page, context, baseURL!, { extra: (route, path) => {
      if (path === '/authorize/two-factor/status') return failing ? fail(route, 500, 'INTERNAL') : ok(route, off);
    } });
    await expect(page.getByText('The two-step verification status could not be loaded.')).toBeVisible();
    failing = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('button', { name: 'Set up two-step verification' })).toBeVisible();
  });

  for (const factor of [
    { name: 'authenticator code', radio: 'Authenticator code', input: '654 321', body: { password: 'Synthetic123', code: '654321' } },
    { name: 'recovery code', radio: 'Recovery code', input: 'abcde-fghjk', body: { password: 'Synthetic123', recoveryCode: 'abcde-fghjk' } },
  ]) {
    test(`turn off with a ${factor.name}`, async ({ page, context, baseURL }) => {
      let status = active;
      const calls = await securityPage(page, context, baseURL!, { status: () => status, extra: (route, path) => {
        if (path === '/authorize/two-factor/disable') { status = off; return ok(route, { success: true }); }
      } });
      await expect(page.getByText('7 recovery codes left')).toBeVisible();
      await page.getByRole('button', { name: 'Turn off two-step verification' }).click();
      const form = page.getByRole('form', { name: 'Turn off two-step verification' });
      await form.getByLabel('Current password').fill('Synthetic123');
      await form.getByRole('radio', { name: factor.radio }).check();
      await form.locator('#two-factor-manage-code').fill(factor.input);
      await form.getByRole('button', { name: 'Turn off', exact: true }).click();
      await expect(page.getByText('Two-step verification is off.')).toBeVisible();
      expect(bodyOf(calls, '/authorize/two-factor/disable')).toEqual(factor.body);
      await expect(page.getByRole('button', { name: 'Set up two-step verification' })).toBeVisible();
    });
  }

  test('turn off refuses a malformed factor before any request; "not enabled" reloads the status', async ({ page, context, baseURL }) => {
    let status = active;
    const calls = await securityPage(page, context, baseURL!, { status: () => status, extra: (route, path) => {
      if (path === '/authorize/two-factor/disable') { status = off; return fail(route, 409, 'TWO_FACTOR_NOT_ENABLED'); }
    } });
    await page.getByRole('button', { name: 'Turn off two-step verification' }).click();
    const form = page.getByRole('form', { name: 'Turn off two-step verification' });
    await form.locator('#two-factor-manage-code').fill('12');
    await form.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(page.getByText('Enter a 6-digit code or a 10-character recovery code.')).toBeVisible();
    expect(count(calls, '/authorize/two-factor/disable')).toBe(0);
    await form.locator('#two-factor-manage-code').fill('123456');
    await form.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(page.getByText('Two-step verification is not on. Reload the page.')).toBeVisible();
    await expect(page.locator('[data-two-factor-status="off"]')).toBeVisible();
  });

  test('regenerate recovery codes takes an authenticator code only and shows the new codes once', async ({ page, context, baseURL }) => {
    const fresh = recoveryCodes.map(code => code.replace('aaaa', 'zzzz'));
    const calls = await securityPage(page, context, baseURL!, { status: () => active, extra: (route, path) => {
      if (path === '/authorize/two-factor/recovery-codes') return ok(route, { recoveryCodes: fresh });
    } });
    await page.getByRole('button', { name: 'New recovery codes' }).click();
    const form = page.getByRole('form', { name: 'New recovery codes' });
    await expect(form.getByRole('radio')).toHaveCount(0);
    await form.getByLabel('Current password').fill('Synthetic123');
    await form.locator('#two-factor-manage-code').fill('111 222');
    await form.getByRole('button', { name: 'Create new codes' }).click();
    await expect(page.getByRole('list', { name: 'Your recovery codes' }).getByText('zzzz9-bbbbb')).toBeVisible();
    expect(bodyOf(calls, '/authorize/two-factor/recovery-codes')).toEqual({ password: 'Synthetic123', code: '111222' });
    await page.getByRole('button', { name: 'I have saved them' }).click();
    await expect(page.getByText('zzzz9-bbbbb')).toHaveCount(0);
  });

  test('recent-authentication failures answer 403: they are explained and never end the session', async ({ page, context, baseURL }) => {
    let reply: 'required' | 'failed' = 'required';
    const calls = await securityPage(page, context, baseURL!, { extra: (route, path) => {
      if (path === '/authorize/two-factor/enrol')
        return reply === 'required' ? fail(route, 403, 'RECENT_AUTHENTICATION_REQUIRED') : fail(route, 403, 'RECENT_AUTHENTICATION_FAILED');
    } });
    await page.getByRole('button', { name: 'Set up two-step verification' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Enter your current password. If your account has no password, sign out, sign in again and retry within 10 minutes.')).toBeVisible();
    reply = 'failed';
    await page.locator('#two-factor-enrol-password').fill('wrong-password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('The password is not correct.')).toBeVisible();
    expect(count(calls, '/authorize/two-factor/enrol')).toBe(2);
    expect(count(calls, '/authorize/refresh')).toBe(0);
    expect(await storedToken(page)).toBe('access');
    await expect(page).toHaveURL(/\/account\/security$/);
  });

  test('zh: the settings are Chinese', async ({ page, context, baseURL }) => {
    await securityPage(page, context, baseURL!, { locale: 'zh', status: () => active });
    await expect(page.getByRole('heading', { name: '两步验证' })).toBeVisible();
    await expect(page.getByText(/自 .* 起已开启 · 剩余 7 个恢复码/)).toBeVisible();
    await page.getByRole('button', { name: '关闭两步验证' }).click();
    await expect(page.getByRole('radio', { name: '验证器验证码' })).toBeChecked();
    await expect(page.getByRole('radio', { name: '恢复码' })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除账号…' })).toBeVisible();
  });
});

test.describe('delete account', () => {
  async function openDialog(page: Page) {
    await page.getByRole('button', { name: 'Delete account…' }).click();
    await page.getByLabel('Type your username (synthetic) to confirm').fill('synthetic');
    await page.locator('#delete-account-password').fill('Synthetic123');
  }

  test('type the username, schedule, and the local session is dropped', async ({ page, context, baseURL }) => {
    const calls = await securityPage(page, context, baseURL!, { extra: (route, path) => {
      if (path === '/authorize/deletion') return ok(route, { scheduled: true, executeAfter: '2026-11-24T10:00:00.000Z' });
    } });
    await expect(page.getByText('deleted 14 days after you confirm').first()).toBeVisible();
    await page.getByRole('button', { name: 'Delete account…' }).click();
    const submit = page.getByRole('button', { name: 'Schedule deletion' });
    await page.getByLabel('Type your username (synthetic) to confirm').fill('someone-else');
    await expect(submit).toBeDisabled();
    await page.getByLabel('Type your username (synthetic) to confirm').fill('synthetic');
    await page.getByLabel('Reason (optional)').fill('Synthetic test');
    await page.locator('#delete-account-password').fill('Synthetic123');
    await submit.click();
    await expect(page.getByText('scheduled for deletion on November 24, 2026')).toBeVisible();
    expect(bodyOf(calls, '/authorize/deletion')).toEqual({ confirm: 'synthetic', reason: 'Synthetic test', password: 'Synthetic123' });
    expect(await storedToken(page)).toBeNull();
    await expect(page.getByRole('button', { name: 'Delete account…' })).toHaveCount(0);
  });

  test('the grace period comes from the policy; deletion switched off hides the dialog', async ({ page, context, baseURL }) => {
    await securityPage(page, context, baseURL!, { policy: { deletionEnabled: true, deletionGraceDays: 1 } });
    await expect(page.getByText('deleted 1 day after you confirm').first()).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await securityPage(page, context, baseURL!, { policy: { deletionEnabled: false } });
    await expect(page.getByText('Self-service account deletion is turned off. Contact support to delete your account.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete account…' })).toHaveCount(0);
  });

  for (const [code, status, message] of [
    ['ACCOUNT_DELETION_CONFIRM_MISMATCH', 400, 'The username does not match.'],
    ['ACCOUNT_HAS_ACTIVE_SUBSCRIPTION', 409, 'Cancel your active subscription (or let it end) before deleting your account.'],
    ['ACCOUNT_HAS_OPEN_REFUND', 409, 'A refund request is still open. Try again once it is settled.'],
    ['ACCOUNT_LAST_SUPERADMIN', 409, 'You are the last administrator. Give another account the superadmin role first.'],
    ['ACCOUNT_DELETION_DISABLED', 403, 'Self-service account deletion is turned off.'],
    ['RECENT_AUTHENTICATION_REQUIRED', 403, 'Enter your current password. If your account has no password, sign out, sign in again and retry within 10 minutes.'],
    ['RECENT_AUTHENTICATION_FAILED', 403, 'The password is not correct.'],
    ['TOO_MANY_REQUESTS', 429, 'Too many attempts. Wait a moment and try again.'],
    ['SOMETHING_UNEXPECTED', 500, 'The deletion could not be scheduled. Try again.'],
  ] as const) {
    test(`refusal ${code} is explained and keeps the session`, async ({ page, context, baseURL }) => {
      const calls = await securityPage(page, context, baseURL!, { extra: (route, path) => {
        if (path === '/authorize/deletion') return fail(route, status, code);
      } });
      await openDialog(page);
      await page.getByRole('button', { name: 'Schedule deletion' }).click();
      await expect(page.getByRole('dialog').getByText(message, { exact: true })).toBeVisible();
      expect(count(calls, '/authorize/deletion')).toBe(1);
      expect(await storedToken(page)).toBe('access');
      await expect(page.getByRole('button', { name: 'Schedule deletion' })).toBeEnabled();
    });
  }

  test('zh: the dialog and the result are Chinese', async ({ page, context, baseURL }) => {
    await securityPage(page, context, baseURL!, { locale: 'zh', extra: (route, path) => {
      if (path === '/authorize/deletion') return ok(route, { scheduled: true, executeAfter: '2026-11-24T10:00:00.000Z' });
    } });
    await page.getByRole('button', { name: '删除账号…' }).click();
    await page.getByLabel('输入用户名（synthetic）以确认').fill('synthetic');
    await page.getByRole('button', { name: '安排删除' }).click();
    await expect(page.getByText(/您的账号将于 2026年11月24日.*删除/)).toBeVisible();
  });
});

test.describe('API key scopes on /account', () => {
  test('AI generation is off by default, shown as a chip on existing keys, and sent when ticked', async ({ page, context, baseURL }) => {
    const calls = await installApi(context, baseURL!, (route, path, body, method) => {
      if (path === '/authorize/me') return ok(route, identity);
      if (path === '/authorize/api-keys' && method === 'GET')
        return ok(route, { apiKeys: [{ id: 'k0', name: 'Old', keyPrefix: 'zk_old', scopes: ['account:read', 'ai:generate'], expiresAt: null, createdAt: '2026-11-01T00:00:00Z' }] });
      if (path === '/authorize/api-keys' && method === 'POST')
        return ok(route, { apiKey: { id: 'k1', name: body.name, keyPrefix: 'zk_new', scopes: body.scopes, expiresAt: null, createdAt: '2026-11-10T00:00:00Z' }, secretKey: 'zk_new_secret_synthetic' });
      if (path === '/authorize/oauth/connections') return ok(route, { connections: [] });
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
    });
    await signedIn(page, context, baseURL!);
    await page.goto('/en/account#security');
    await expect(page.getByRole('link', { name: 'Open security settings' })).toBeVisible();
    await expect(page.locator('[data-scope="ai:generate"]').first()).toBeVisible();
    const toggle = page.getByRole('checkbox', { name: /Generate with AI/ });
    await expect(toggle).not.toBeChecked();
    await page.getByLabel('Key name').fill('Plain');
    await page.getByRole('button', { name: 'Create key' }).click();
    await expect(page.locator('#created-api-key').or(page.getByText('zk_new_secret_synthetic')).first()).toBeVisible();
    expect(calls.filter(call => call.path === '/authorize/api-keys' && call.method === 'POST')[0]!.body.scopes).toEqual(['account:read']);
    await page.getByRole('button', { name: 'I saved this key' }).click();
    await page.getByLabel('Key name').fill('Generator');
    await toggle.check();
    await page.getByRole('button', { name: 'Create key' }).click();
    await expect.poll(() => calls.filter(call => call.path === '/authorize/api-keys' && call.method === 'POST').length).toBe(2);
    expect(calls.filter(call => call.path === '/authorize/api-keys' && call.method === 'POST')[1]!.body.scopes).toEqual(['account:read', 'ai:generate']);
  });
});
