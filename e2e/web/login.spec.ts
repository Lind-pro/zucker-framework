/** Synthetic account contract checks: no real backend or email. */
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

const identity = { id: 'synthetic-user', username: 'synthetic', name: 'Synthetic member', email: 'synthetic@example.test', emailVerified: true,
  permissions: [{ id: '*', actions: ['*'] }] };
const respond = (route: Route, result: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status,
  contentType: 'application/json', headers, body: JSON.stringify({ status, result, message: status < 400 ? 'success' : 'Invalid credentials' }) });
async function mockAccount(page: Page, validLogin = true) {
  const calls: string[] = [];
  await page.route('**/api/authorize/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return respond(route, { apiKeys: [] }); calls.push(path);
    if (path.endsWith('/login')) return validLogin
      ? respond(route, { userId: identity.id, token: 'synthetic-access', expires: 900000 }, 200,
        { 'set-cookie': 'zucker-session=synthetic-refresh; Path=/; HttpOnly; SameSite=Lax' })
      : respond(route, null, 401);
    if (path.endsWith('/me')) return respond(route, identity);
    if (path.endsWith('/sessions')) return respond(route, []);
    if (path.endsWith('/refresh')) return respond(route, { access_token: 'synthetic-renewed-access' });
    return respond(route, null, 404);
  });
  return calls;
}
async function signIn(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill('synthetic');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic123');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
}

test.describe('Web account sign-in', () => {
  test('preserves locale, HttpOnly refresh cookie and wildcard permissions', async ({ page }) => {
    await mockAccount(page); await page.goto('/en/login'); await signIn(page);
    await expect(page).toHaveURL(/\/en\/account$/);
    const cookies = await page.context().cookies();
    expect(cookies.find(cookie => cookie.name === 'zucker-session')).toMatchObject({ value: 'synthetic-refresh', httpOnly: true });
    expect(cookies.some(cookie => cookie.name === 'auth-token')).toBe(false);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state);
    expect(stored.permissions).toContain('*'); expect(stored.permissions).not.toContain('*:*');
    expect(stored.refreshToken).toBeNull();
    expect(await page.evaluate(() => document.cookie)).not.toContain('synthetic-refresh');
    await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  });
  test('bad credentials stay on the same page without refreshing another session', async ({ page }) => {
    const calls = await mockAccount(page, false); await page.goto('/en/login'); await signIn(page);
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Sign-in failed');
    await expect(page).toHaveURL(/\/en\/login$/);
    expect(calls.filter(path => path.endsWith('/refresh'))).toHaveLength(0);
  });
  for (const target of ['//outside.example/path', '/\\outside.example/path', '/%2Foutside.example/path']) {
    test(`rejects external redirect ${target}`, async ({ page }) => {
      await mockAccount(page); await page.goto(`/en/login?redirect=${encodeURIComponent(target)}`); await signIn(page);
      await expect(page).toHaveURL(/\/en\/account$/);
    });
  }
  test('returns to an authorized locale-aware account path', async ({ page }) => {
    await mockAccount(page); await page.goto('/en/login?redirect=%2Fen%2Faccount'); await signIn(page);
    await expect(page).toHaveURL(/\/en\/account$/);
    await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  });
  test('forgot-password link has a real localized destination', async ({ page }) => {
    await page.goto('/en/login'); await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/en\/forgot-password$/);
    await expect(page.getByRole('button', { name: 'Send reset link' })).toBeVisible();
  });
});
