/** Sign-in second factor, pending-deletion cancel, mailed deletion-cancel link and email sign-in links. Synthetic API only. */
import { test, expect } from '@playwright/test';
import { bodyOf, challenge, count, fail, identity, installApi, ok, ticket } from './account-security-fixtures';

const session = { userId: 'u', token: 'access', expires: 900 };

test.describe('login second factor', () => {
  test('a wrong code is explained, then a recovery code signs in; the magic-link request is neutral', async ({ page, context, baseURL }) => {
    let attempts = 0;
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, { policies: { account: { values: { magicLinkEnabled: true } } } });
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
      if (path === '/authorize/login') return ok(route, { twoFactorRequired: true, challenge });
      if (path === '/authorize/login/two-factor') return ++attempts === 1 ? fail(route, 401, 'TWO_FACTOR_CODE_INVALID') : ok(route, session);
      if (path === '/authorize/me') return ok(route, identity);
      if (path === '/authorize/magic-link') return ok(route, { accepted: true });
    });
    await page.goto('/en/login');
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(page.getByText('a sign-in link is on its way')).toBeVisible();
    await page.getByLabel('Username').fill('synthetic');
    await page.getByLabel('Password', { exact: true }).fill('Synthetic123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByLabel('Authentication code').fill('123 456');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('That code is not valid')).toBeVisible();
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill('abcde-fghjk');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/account$/);
    expect(calls.filter(call => call.path === '/authorize/login/two-factor').map(call => call.body))
      .toEqual([{ challenge, code: '123456' }, { challenge, recoveryCode: 'abcde-fghjk' }]);
    expect(bodyOf(calls, '/authorize/magic-link')).toEqual({ email: 'synthetic@example.test' });
  });

  test('malformed input is refused before any request and server failures are explained', async ({ page, context, baseURL }) => {
    let reply: 'restart' | 'limit' | 'down' = 'restart';
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
      if (path === '/authorize/login') return ok(route, { twoFactorRequired: true, challenge });
      if (path === '/authorize/login/two-factor')
        return reply === 'restart' ? fail(route, 401, 'TWO_FACTOR_CHALLENGE_INVALID') : reply === 'limit' ? fail(route, 429, 'TOO_MANY_REQUESTS') : fail(route, 503, 'TWO_FACTOR_UNAVAILABLE');
    });
    await page.goto('/en/login');
    await page.getByLabel('Username').fill('synthetic');
    await page.getByLabel('Password', { exact: true }).fill('Synthetic123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByLabel('Authentication code').fill('12');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('Enter the 6-digit code.')).toBeVisible();
    expect(count(calls, '/authorize/login/two-factor')).toBe(0);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill('short');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('Enter a 10-character recovery code.')).toBeVisible();
    expect(count(calls, '/authorize/login/two-factor')).toBe(0);
    await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
    reply = 'limit';
    await page.getByLabel('Authentication code').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('Too many attempts. Wait a moment and try again.')).toBeVisible();
    reply = 'down';
    await page.getByLabel('Authentication code').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('Two-step verification is unavailable on this server right now.')).toBeVisible();
    // An expired or used challenge cannot be retried: only "Start over" is left.
    reply = 'restart';
    await page.getByLabel('Authentication code').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('This sign-in step has expired. Sign in again.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByLabel('Username')).toBeVisible();
  });

  test('zh: the second factor step and its errors are Chinese', async ({ page, context, baseURL }) => {
    let attempts = 0;
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, { policies: { account: { values: { magicLinkEnabled: true } } } });
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
      if (path === '/authorize/login') return ok(route, { twoFactorRequired: true, challenge });
      if (path === '/authorize/login/two-factor') return ++attempts === 1 ? fail(route, 401, 'TWO_FACTOR_CODE_INVALID') : ok(route, session);
      if (path === '/authorize/me') return ok(route, identity);
    });
    await page.goto('/zh/login');
    await expect(page.getByRole('button', { name: '通过邮件发送登录链接' })).toBeVisible();
    await page.getByLabel('用户名').fill('synthetic');
    await page.getByLabel('密码', { exact: true }).fill('Synthetic123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText('请输入身份验证器应用中的 6 位验证码。')).toBeVisible();
    await page.getByLabel('验证码').fill('123456');
    await page.getByRole('button', { name: '验证', exact: true }).click();
    await expect(page.getByText('验证码无效。请检查设备时间后重试。')).toBeVisible();
    await page.getByRole('button', { name: '改用恢复码' }).click();
    await page.getByLabel('恢复码').fill('abcde-fghjk');
    await page.getByRole('button', { name: '验证', exact: true }).click();
    await expect(page).toHaveURL(/\/zh\/account$/);
    expect(bodyOf(calls, '/authorize/login/two-factor', 1)).toEqual({ challenge, recoveryCode: 'abcde-fghjk' });
  });
});

test.describe('email sign-in links', () => {
  test('the toggle is hidden unless the public policy turns it on', async ({ page, context, baseURL }) => {
    await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, { policies: { account: { values: { magicLinkEnabled: false } } } });
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
    });
    await page.goto('/en/login');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toHaveCount(0);
  });

  test('the toggle is hidden when the policy cannot be read', async ({ page, context, baseURL }) => {
    await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return fail(route, 500, 'INTERNAL');
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
    });
    await page.goto('/en/login');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toHaveCount(0);
  });

  test('a server that turned links off after the page loaded is explained', async ({ page, context, baseURL }) => {
    await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, { policies: { account: { values: { magicLinkEnabled: true } } } });
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
      if (path === '/authorize/magic-link') return fail(route, 403, 'MAGIC_LINK_DISABLED');
    });
    await page.goto('/en/login');
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
    await page.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(page.getByText('Email sign-in links are turned off.')).toBeVisible();
    await expect(page.getByText('a sign-in link is on its way')).toHaveCount(0);
  });

  test('the link page consumes the ticket only on click, removes it from the URL first, and handles the second factor', async ({ page, context, baseURL }) => {
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/authorize/magic-link/consume') return ok(route, { twoFactorRequired: true, challenge });
      if (path === '/authorize/login/two-factor') return ok(route, session);
      if (path === '/authorize/me') return ok(route, identity);
    });
    await page.goto(`/en/magic-link#ticket=${ticket}`);
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    await expect.poll(() => page.url()).not.toContain(ticket);
    expect(calls).toHaveLength(0);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Authentication code').fill('654321');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/account$/);
    expect(bodyOf(calls, '/authorize/magic-link/consume')).toEqual({ ticket });
    expect(calls.every(call => !call.path.includes(ticket))).toBe(true);
  });

  test('an invalid or missing ticket is explained and never calls the API', async ({ page, context, baseURL }) => {
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/authorize/magic-link/consume') return fail(route, 401, 'MAGIC_LINK_INVALID');
    });
    await page.goto('/en/magic-link');
    await expect(page.getByText('This sign-in link is invalid or has expired.')).toBeVisible();
    expect(calls).toHaveLength(0);
    await page.goto(`/en/magic-link#ticket=${ticket}`);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('This sign-in link is invalid or has expired.')).toBeVisible();
    await expect(page).toHaveURL(/\/magic-link$/);
  });

  test('zh: the link page is Chinese', async ({ page, context, baseURL }) => {
    await installApi(context, baseURL!, () => undefined);
    await page.goto(`/zh/magic-link#ticket=${ticket}`);
    await expect(page.getByRole('heading', { name: '通过邮件链接登录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  });
});

test.describe('account scheduled for deletion', () => {
  test('signing in explains the pending deletion; cancelling with the password signs in', async ({ page, context, baseURL }) => {
    let logins = 0;
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
      if (path === '/authorize/login') return ++logins === 1 ? fail(route, 403, 'ACCOUNT_DELETION_PENDING', { executeAfter: '2026-11-17T10:00:00.000Z' }) : ok(route, session);
      if (path === '/authorize/deletion/cancel') return ok(route, { cancelled: true });
      if (path === '/authorize/me') return ok(route, identity);
    });
    await page.goto('/en/login');
    await page.getByLabel('Username').fill('synthetic');
    await page.getByLabel('Password', { exact: true }).fill('Synthetic123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.getByText('scheduled for deletion on November 17, 2026')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel deletion and sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);
    expect(bodyOf(calls, '/authorize/deletion/cancel')).toEqual({ username: 'synthetic', password: 'Synthetic123' });
  });

  test('a rejected cancel stays on the explanation; "not pending any more" asks to sign in again', async ({ page, context, baseURL }) => {
    let reply: 'wrong' | 'gone' = 'wrong';
    await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
      if (path === '/authorize/login') return fail(route, 403, 'ACCOUNT_DELETION_PENDING', { executeAfter: '2026-11-17T10:00:00.000Z' });
      if (path === '/authorize/deletion/cancel') return reply === 'wrong' ? fail(route, 401, 'INVALID_CREDENTIALS') : fail(route, 409, 'ACCOUNT_DELETION_NOT_PENDING');
    });
    await page.goto('/en/login');
    await page.getByLabel('Username').fill('synthetic');
    await page.getByLabel('Password', { exact: true }).fill('wrong-password-1');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel deletion and sign in' }).click();
    await expect(page.getByText('The deletion could not be cancelled. Check your password and try again.')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    reply = 'gone';
    await page.getByRole('button', { name: 'Cancel deletion and sign in' }).click();
    await expect(page.getByText('No deletion is scheduled for this account any more. Sign in again.')).toBeVisible();
  });

  test('zh: the explanation is Chinese with a localised date', async ({ page, context, baseURL }) => {
    await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
      if (path === '/authorize/login') return fail(route, 403, 'ACCOUNT_DELETION_PENDING', { executeAfter: '2026-11-17T10:00:00.000Z' });
    });
    await page.goto('/zh/login');
    await page.getByLabel('用户名').fill('synthetic');
    await page.getByLabel('密码', { exact: true }).fill('Synthetic123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText(/此账号将于 2026年11月17日.*删除/)).toBeVisible();
    await expect(page.getByRole('button', { name: '取消删除并登录' })).toBeVisible();
  });

  test('the mailed cancel link cancels with its ticket, removes it from the URL, and a bad ticket is explained', async ({ page, context, baseURL }) => {
    let valid = true;
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/providers') return ok(route, { providers: [] });
      if (path === '/authorize/deletion/cancel') return valid ? ok(route, { cancelled: true }) : fail(route, 400, 'DELETION_TICKET_INVALID');
    });
    await page.goto(`/en/login#cancel-deletion=${ticket}`);
    await expect(page.getByRole('button', { name: 'Cancel the deletion' })).toBeVisible();
    await expect.poll(() => page.url()).not.toContain(ticket);
    await page.getByRole('button', { name: 'Cancel the deletion' }).click();
    await expect(page.getByText('The deletion is cancelled')).toBeVisible();
    expect(bodyOf(calls, '/authorize/deletion/cancel')).toEqual({ ticket });
    valid = false;
    await page.goto(`/en/login#cancel-deletion=${ticket}`);
    await page.getByRole('button', { name: 'Cancel the deletion' }).click();
    await expect(page.getByText('This link is invalid or has expired. Sign in with your password to cancel the deletion.')).toBeVisible();
  });
});
