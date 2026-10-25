import { test, expect, type Page, type Route } from '@playwright/test';

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL) throw new Error('Synthetic account checks require a local baseURL');
  const origin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'analytics.example.test') return route.fulfill({ contentType: 'application/javascript', body: 'window.__syntheticAnalyticsLoaded = true;' });
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ status: 503, result: null, message: 'Unmocked synthetic API request' }) });
    return route.continue();
  });
});

const ticket = 's'.repeat(43);
const identity = { id: 'synthetic-user', username: 'synthetic', name: 'Synthetic member', email: 'synthetic@example.test', emailVerified: true,
  permissions: [{ id: 'superadmin', actions: ['*'] }] };
const envelope = (route: Route, result: unknown, status = 200, message = 'success', headers: Record<string, string> = {}) => route.fulfill({
  status, contentType: 'application/json', headers, body: JSON.stringify({ status, message, result }),
});
async function addSession(page: Page) {
  await page.goto('/en/login');
  await page.context().addCookies([{ name: 'zucker-session', value: 'synthetic-only-cookie', url: new URL(page.url()).origin, httpOnly: true, sameSite: 'Lax' }]);
  await page.evaluate(() => localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: {
    token: 'expired-access', refreshToken: null, isAuthenticated: true, user: { id: 'synthetic-user', username: 'synthetic' }, permissions: [],
  } })));
}

test.describe('Web public email flows', () => {
  test('registers with the public endpoint and waits for verification', async ({ page }) => {
    const requests: Array<{ path: string; body: unknown }> = [];
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return envelope(route, { apiKeys: [] });
      requests.push({ path, body: route.request().postDataJSON() });
      return path === '/api/authorize/register' ? envelope(route, { verificationRequired: true }) : envelope(route, null, 404);
    });
    await page.goto('/en/register');
    await page.getByLabel('Username', { exact: true }).fill('synthetic');
    await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Synthetic123');
    await page.getByLabel('Confirm Password', { exact: true }).fill('Synthetic123');
    await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('verify it before signing in');
    expect(requests).toEqual([{ path: '/api/authorize/register', body: { username: 'synthetic', email: 'synthetic@example.test', password: 'Synthetic123', locale: 'en' } }]);
    await expect(page).toHaveURL(/\/en\/register$/);
  });
  test('reads a fragment ticket once and verifies only on explicit confirmation', async ({ page }) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    await page.route('**/api/authorize/verify-email', route => {
      calls.push({ url: route.request().url(), body: route.request().postDataJSON() }); return envelope(route, { success: true });
    });
    await page.goto(`/en/verify-email#ticket=${ticket}`);
    await expect(page.getByRole('button', { name: 'Verify email', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/en\/verify-email$/); expect(calls).toHaveLength(0);
    await page.getByRole('button', { name: 'Verify email', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Your email is verified');
    expect(calls).toHaveLength(1); expect(calls[0].body).toEqual({ ticket }); expect(calls[0].url).not.toContain(ticket);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(ticket);
  });
  test('expired verification has an error and a neutral resend response', async ({ page }) => {
    await page.route('**/api/authorize/verify-email', route => envelope(route, null, 400, 'Invalid or expired ticket'));
    await page.route('**/api/authorize/verification', route => envelope(route, { accepted: true }));
    await page.goto(`/en/verify-email#ticket=${ticket}`);
    await page.getByRole('button', { name: 'Verify email', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('invalid or expired');
    await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
    await page.getByRole('button', { name: 'Send verification email' }).click();
    await expect(page.getByRole('status')).toContainText('If an eligible account exists');
  });
  test('reset-mail request does not reveal whether an account exists', async ({ page }) => {
    let body: unknown;
    await page.route('**/api/authorize/forgot-password', route => { body = route.request().postDataJSON(); return envelope(route, { accepted: true }); });
    await page.goto('/en/forgot-password'); await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('If an eligible account exists'); expect(body).toEqual({ email: 'synthetic@example.test' });
  });
  test('reset blocks mismatched passwords and submits the fragment ticket only in the body', async ({ page }) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    await page.route('**/api/authorize/reset-password', route => { calls.push({ url: route.request().url(), body: route.request().postDataJSON() }); return envelope(route, { success: true }); });
    await page.goto(`/en/reset-password#ticket=${ticket}`);
    await page.getByLabel('New password', { exact: true }).fill('Synthetic123');
    await page.getByLabel('Confirm Password', { exact: true }).fill('Different123');
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('The passwords do not match.'); expect(calls).toHaveLength(0);
    await page.getByLabel('Confirm Password', { exact: true }).fill('Synthetic123');
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('previous sessions have been revoked');
    expect(calls).toHaveLength(1); expect(calls[0].body).toEqual({ ticket, password: 'Synthetic123' }); expect(calls[0].url).not.toContain(ticket);
    await expect(page).toHaveURL(/\/en\/reset-password$/);
  });
});

test.describe('Web account sessions', () => {
  test('shares Cookie refresh for expired concurrent reads and preserves superadmin', async ({ page }) => {
    let refreshes = 0;
    await page.route('**/api/authorize/**', route => {
      const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return envelope(route, { apiKeys: [] });
      if (path.endsWith('/refresh')) { refreshes++; expect(route.request().postDataJSON()).toEqual({}); return envelope(route, { access_token: 'fresh-access' }); }
      if (route.request().headers().authorization !== 'Bearer fresh-access') return envelope(route, null, 401, 'Expired access');
      if (path.endsWith('/me')) return envelope(route, identity);
      if (path.endsWith('/sessions')) return envelope(route, []);
      return envelope(route, null, 404);
    });
    await addSession(page); await page.goto('/en/account');
    await expect(page.getByLabel('Display name')).toHaveValue('Synthetic member');
    await expect(page.getByText('No active sessions were returned.')).toBeVisible(); expect(refreshes).toBe(1);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state);
    expect(stored.token).toBe('fresh-access'); expect(stored.refreshToken).toBeNull();
    expect(stored.permissions).toContain('superadmin'); expect(stored.permissions).not.toContain('superadmin:*');
    expect(await page.evaluate(() => document.cookie)).not.toContain('synthetic-only-cookie');
  });
  test('keeps profile available while sessions fail and revokes only the selected session', async ({ page }) => {
    let failSessions = true; const mutations: string[] = [];
    await page.route('**/api/authorize/**', route => {
      const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return envelope(route, { apiKeys: [] });
      if (path.endsWith('/me')) return envelope(route, identity);
      if (path.endsWith('/sessions') && failSessions) return envelope(route, null, 503, 'Unavailable');
      if (path.endsWith('/sessions')) return envelope(route, [{ id: 'owned-session', current: true, expiresAt: '2026-11-24T12:00:00Z', lastActiveAt: '2026-10-24T12:00:00Z' }]);
      if (path.endsWith('/sessions/owned-session') && route.request().method() === 'DELETE') {
        mutations.push(path); return envelope(route, { success: true }, 200, 'success', { 'set-cookie': 'zucker-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
      }
      return envelope(route, null, 404);
    });
    await addSession(page); await page.goto('/en/account');
    await expect(page.getByLabel('Display name')).toHaveValue('Synthetic member');
    const sessions = page.getByRole('region', { name: 'Signed-in sessions' });
    await expect(sessions.getByRole('alert')).toBeVisible(); failSessions = false;
    await sessions.getByRole('button', { name: 'Retry' }).click();
    await sessions.getByRole('button', { name: 'Sign out this session' }).click();
    await expect(page).toHaveURL(/\/en\/login$/); expect(mutations).toEqual(['/api/authorize/sessions/owned-session']);
  });
});

test('profile and password forms use the account contracts without refreshing on an incorrect current password', async ({ page }) => {
  const writes: Array<{ path: string; body: unknown }> = []; let refreshes = 0, rejectPassword = true;
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return envelope(route, { apiKeys: [] });
    if (path.endsWith('/me')) return envelope(route, identity);
    if (path.endsWith('/sessions')) return envelope(route, []);
    if (path.endsWith('/refresh')) { refreshes++; return envelope(route, { access_token: 'fresh-access' }); }
    if (path.endsWith('/oauth/providers')) return envelope(route, { providers: [] });
    if (path.endsWith('/oauth/connections')) return envelope(route, { connections: [] });
    writes.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith('/profile')) return envelope(route, { success: true });
    if (path.endsWith('/password')) {
      expect(new URL(route.request().url()).search).toBe('');
      expect(route.request().headers().authorization).toBe('Bearer expired-access');
      return rejectPassword ? envelope(route, null, 401, 'Invalid current password')
        : envelope(route, { success: true }, 200, 'success', { 'set-cookie': 'zucker-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
    }
    return envelope(route, null, 404);
  });
  await addSession(page); await page.goto('/en/account');
  await expect(page.getByLabel('Display name')).toHaveValue('Synthetic member');
  await page.getByLabel('Display name').fill('Updated synthetic member');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();
  expect(writes[0]).toEqual({ path: '/api/authorize/profile', body: { name: 'Updated synthetic member', locale: 'en' } });
  const form = page.getByRole('region', { name: 'Change password', exact: true });
  await form.getByLabel('Current password', { exact: true }).fill('Incorrect123');
  await form.getByLabel('New password', { exact: true }).fill('Synthetic456');
  await form.getByLabel('Confirm Password', { exact: true }).fill('Synthetic456');
  await form.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Could not change the password');
  expect(refreshes).toBe(0); await expect(page).toHaveURL(/\/en\/account$/);
  rejectPassword = false;
  await form.getByLabel('Current password', { exact: true }).fill('Synthetic123');
  await form.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/login\?changed=1$/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state.isAuthenticated)).toBe(false);
  expect((await page.context().cookies()).some(cookie => cookie.name === 'zucker-session')).toBe(false);
});

test('logout failure is not reported as successful and a successful retry clears the local account', async ({ page }) => {
  let failLogout = true;
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return envelope(route, { apiKeys: [] });
    if (path.endsWith('/me')) return envelope(route, identity);
    if (path.endsWith('/sessions')) return envelope(route, []);
    if (path.endsWith('/logout')) return failLogout ? envelope(route, null, 503, 'Unavailable')
      : envelope(route, { success: true }, 200, 'success', { 'set-cookie': 'zucker-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
    return envelope(route, null, 404);
  });
  await addSession(page); await page.goto('/en/account');
  await expect(page.getByLabel('Display name')).toHaveValue('Synthetic member');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible(); await expect(page).toHaveURL(/\/en\/account$/);
  failLogout = false;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/login$/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state.isAuthenticated)).toBe(false);
});

test.describe('Configured analytics account boundary', () => {
  // Start Web with SITE_ANALYTICS_ENABLED=true PLAUSIBLE_ENABLED=true
  // PLAUSIBLE_SCRIPT_URL=https://analytics.example.test/synthetic.js, then opt this suite in.
  test.skip(process.env.WEB_ACCOUNT_ANALYTICS_REVIEW !== '1', 'Requires the explicitly enabled synthetic analytics fixture');
  test('starts a clean document for account links and never exposes ticket pages to the configured third party', async ({ page }) => {
    const external: Array<{ url: string; page: string }> = [];
    await page.route('https://analytics.example.test/**', route => {
      external.push({ url: route.request().url(), page: page.url() });
      return route.fulfill({ contentType: 'application/javascript', body: 'window.__syntheticAnalyticsLoaded = true;' });
    });
    await page.goto('/en');
    await expect(page.locator('#zucker-analytics-plausible-script')).toHaveAttribute('src', 'https://analytics.example.test/synthetic.js');
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__syntheticAnalyticsLoaded'))).toBe(true);
    await page.locator('header').getByRole('link', { name: 'Sign In', exact: true }).first().click();
    await expect(page).toHaveURL(/\/en\/login$/);
    await expect(page.locator('script[id^="zucker-analytics-"]')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, '__syntheticAnalyticsLoaded'))).toBeUndefined();
    const count = external.length;
    for (const path of ['register', 'forgot-password', 'verify-email', 'reset-password']) {
      await page.goto(`/en/${path}${path.includes('password') && path !== 'forgot-password' || path === 'verify-email' ? `#ticket=${ticket}` : ''}`);
      await expect(page.locator('script[id^="zucker-analytics-"]')).toHaveCount(0);
      if (path === 'verify-email') await expect(page.getByRole('button', { name: 'Verify email', exact: true })).toBeVisible();
      if (path === 'reset-password') await expect(page.getByLabel('New password')).toBeVisible();
      await expect(page).not.toHaveURL(/#ticket=/);
    }
    expect(external.length).toBe(count);
    expect(external.every(call => !call.url.includes(ticket) && !call.page.includes(ticket))).toBe(true);
  });
});
