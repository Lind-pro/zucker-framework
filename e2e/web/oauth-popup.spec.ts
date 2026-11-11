/** OAuth sign-in in a popup: happy path with the second factor, blocked popup fallback, failures, and windows without an opener. Synthetic provider. */
import { test, expect } from '@playwright/test';
import { bodyOf, challenge, count, fail, identity, installApi, ok, proof } from './account-security-fixtures';

const authorizeUrl = 'https://github.com/login/oauth/authorize?client_id=x&state=s';
const state = 's'.repeat(43);
const providers = { providers: [{ id: 'github', code: true }] };

test.describe('oauth popup', () => {
  // The popup waits up to DEFAULT_CLAIM_TIMEOUT_MS (3 s, fe-auth oauth-popup.ts) for the opener to claim the sign-in over
  // BroadcastChannel, enough headroom on a loaded host; no retries, a miss is a real failure.
  // Listen for the popup's `close` before the action that ends the sign-in: the popup can close while that click is still
  // resolving, and a `close` emitted before `waitForEvent` is registered is never seen (the test then hangs).
  test('completes in the popup (with the second factor), closes it and restores the opener from the session cookie', async ({ page, context, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/providers') return ok(route, providers);
      if (path === '/authorize/oauth/github/start') return ok(route, { authorizationUrl: authorizeUrl });
      if (path === '/authorize/oauth/github/complete') return ok(route, { twoFactorRequired: true, challenge, returnPath: '/billing/orders' });
      if (path === '/authorize/login/two-factor') return ok(route, { userId: 'u', token: 'popup-access', expires: 900 });
      if (path === '/authorize/refresh') return ok(route, { access_token: 'opener-access' });
      if (path === '/authorize/me') return ok(route, identity);
    });
    // The provider redirects the popup back to the callback with the one-time proof in the fragment.
    await context.route('https://github.com/**', route => route.fulfill({ status: 302, headers: { Location: `${origin}/oauth/callback?provider=github&purpose=login#ticket=${proof}` } }));
    await page.goto('/en/login');
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Continue with GitHub' }).click();
    const popup = await popupPromise;
    const closed = popup.waitForEvent('close');
    await popup.getByRole('button', { name: 'Continue signing in' }).click();
    await popup.getByLabel('Authentication code').fill('111222');
    await popup.getByRole('button', { name: 'Verify' }).click();
    await closed;
    await expect(page).toHaveURL(/\/billing\/orders$/);
    expect(count(calls, '/authorize/refresh')).toBeGreaterThan(0);
    expect(bodyOf(calls, '/authorize/oauth/github/start')).toEqual({ locale: 'en', mode: 'code', returnPath: '/account' });
    expect(bodyOf(calls, '/authorize/oauth/github/complete')).toEqual({ proof });
    // No token or proof travels to the opener: the opener's URL never held them.
    expect(page.url()).not.toContain(proof);
  });

  test('a blocked popup falls back to the redirect flow once', async ({ page, context, baseURL }) => {
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/providers') return ok(route, providers);
      if (path === '/authorize/oauth/github/start') return ok(route, { authorizationUrl: authorizeUrl });
    });
    await page.addInitScript(() => { window.open = () => null; });
    await page.goto('/en/login');
    const navigation = page.waitForRequest(request => request.url().startsWith('https://github.com/login/oauth/authorize'));
    await page.getByRole('button', { name: 'Continue with GitHub' }).click();
    await navigation;
    expect(count(calls, '/authorize/oauth/github/start')).toBe(1);
  });

  for (const [name, status, code, message] of [
    ['an expired callback', 400, 'OAUTH_PROOF_INVALID', 'This sign-in link is missing, expired or already used. Start a new sign-in.'],
    ['an existing account', 409, 'OAUTH_ACCOUNT_EXISTS', 'An account with this email or provider already exists.'],
    ['rate limiting', 429, 'TOO_MANY_REQUESTS', 'Too many requests.'],
    ['a provider failure', 502, 'OAUTH_PROVIDER_FAILED', 'Provider sign-in could not be completed.'],
  ] as const) {
    test(`a popup that fails with ${name} reports it to the opener and closes`, async ({ page, context, baseURL }) => {
      const origin = new URL(baseURL!).origin;
      await installApi(context, baseURL!, (route, path) => {
        if (path === '/site/public/config') return ok(route, {});
        if (path === '/authorize/oauth/providers') return ok(route, providers);
        if (path === '/authorize/oauth/github/start') return ok(route, { authorizationUrl: authorizeUrl });
        if (path === '/authorize/oauth/github/complete') return fail(route, status, code);
      });
      await context.route('https://github.com/**', route => route.fulfill({ status: 302, headers: { Location: `${origin}/oauth/callback?provider=github&purpose=login#ticket=${proof}` } }));
      await page.goto('/en/login');
      const popupPromise = page.waitForEvent('popup');
      await page.getByRole('button', { name: 'Continue with GitHub' }).click();
      const popup = await popupPromise;
      const closed = popup.waitForEvent('close');
      await popup.getByRole('button', { name: 'Continue signing in' }).click();
      await closed;
      await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
    });
  }

  test('a popup whose provider step failed (error in the callback URL) tells the opener and closes', async ({ page, context, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/providers') return ok(route, providers);
      if (path === '/authorize/oauth/github/start') return ok(route, { authorizationUrl: authorizeUrl });
    });
    await context.route('https://github.com/**', route => route.fulfill({ status: 302, headers: { Location: `${origin}/oauth/callback?provider=github&error=access_denied` } }));
    await page.goto('/en/login');
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Continue with GitHub' }).click();
    const popup = await popupPromise;
    await popup.waitForEvent('close');
    await expect(page.getByRole('alert').filter({ hasText: 'This sign-in link is missing, expired or already used.' })).toBeVisible();
  });
});

test.describe('oauth windows without an opener', () => {
  test('the popup start page explains an invalid start without calling the API', async ({ page, context, baseURL }) => {
    const calls = await installApi(context, baseURL!, () => undefined);
    for (const hash of ['', '#provider=evil&state=' + state, '#provider=github&state=short', `#provider=github&state=${state}&returnPath=//evil.example`]) {
      await page.goto(`/en/oauth/popup${hash}`);
      await expect(page.getByText('This sign-in link is missing, expired or already used. Start a new sign-in.')).toBeVisible();
    }
    expect(calls).toHaveLength(0);
  });

  test('the popup start page without an opener shows a start failure in place', async ({ page, context, baseURL }) => {
    await installApi(context, baseURL!, (route, path) => {
      if (path === '/authorize/oauth/github/start') return fail(route, 429, 'TOO_MANY_REQUESTS');
    });
    await page.goto(`/en/oauth/popup#provider=github&state=${state}&returnPath=/account`);
    await expect(page.getByText('Too many requests.')).toBeVisible();
    await expect.poll(() => page.url()).not.toContain(state);
    expect(await page.evaluate(() => sessionStorage.getItem('zucker-oauth-popup-state'))).toBeNull();
  });

  test('the callback without a popup state completes by redirect in the same tab', async ({ page, context, baseURL }) => {
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/github/complete') return ok(route, { userId: 'u', token: 'access', expires: 900 });
      if (path === '/authorize/me') return ok(route, identity);
    });
    await page.goto(`/en/oauth/callback?provider=github&purpose=login#ticket=${proof}`);
    await page.getByRole('button', { name: 'Continue signing in' }).click();
    await expect(page).toHaveURL(/\/account$/);
    expect(bodyOf(calls, '/authorize/oauth/github/complete')).toEqual({ proof });
  });

  test('a stale popup state with no opener to claim it falls back to the redirect completion', async ({ page, context, baseURL }) => {
    const calls = await installApi(context, baseURL!, (route, path) => {
      if (path === '/site/public/config') return ok(route, {});
      if (path === '/authorize/oauth/github/complete') return ok(route, { userId: 'u', token: 'access', expires: 900 });
      if (path === '/authorize/me') return ok(route, identity);
    });
    await page.addInitScript(value => { try { sessionStorage.setItem('zucker-oauth-popup-state', value); } catch { /* ignore */ } }, state);
    await page.goto(`/en/oauth/callback?provider=github&purpose=login#ticket=${proof}`);
    await page.getByRole('button', { name: 'Continue signing in' }).click({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/account$/);
    expect(count(calls, '/authorize/oauth/github/complete')).toBe(1);
    expect(await page.evaluate(() => sessionStorage.getItem('zucker-oauth-popup-state'))).toBeNull();
  });

  test('a callback without a proof, with a bad provider or an error is refused without calling the API', async ({ page, context, baseURL }) => {
    const calls = await installApi(context, baseURL!, () => undefined);
    for (const url of ['/en/oauth/callback?provider=github&purpose=login', `/en/oauth/callback?provider=evil#ticket=${proof}`,
      `/en/oauth/callback?provider=github&error=access_denied#ticket=${proof}`]) {
      await page.goto(url);
      await expect(page.getByText('This sign-in link is missing, expired or already used. Start a new sign-in.')).toBeVisible();
    }
    expect(calls).toHaveLength(0);
  });

  test('zh: the popup and callback pages are Chinese', async ({ page, context, baseURL }) => {
    await installApi(context, baseURL!, () => undefined);
    await page.goto('/zh/oauth/callback?provider=github');
    await expect(page.getByText('登录链接缺失、已过期或已使用，请重新发起登录。')).toBeVisible();
  });
});
