import { test, expect, type Page, type Route } from '@playwright/test';

const ticket = 'p'.repeat(43), clientId = 'synthetic-google-client';
const identity = { id: 'synthetic-member', username: 'synthetic', name: 'Synthetic member', email: 'member@example.test', emailVerified: true, permissions: [] };
const respond = (route: Route, result: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status,
  contentType: 'application/json', headers, body: JSON.stringify({ status, result, message: status === 200 ? 'success' : 'Synthetic failure' }) });
const authCookie = { 'set-cookie': 'zucker-session=synthetic-refresh; Path=/; HttpOnly; SameSite=Lax' };
async function existingAccount(page: Page) {
  await page.goto('/en/login');
  await page.context().addCookies([{ name: 'zucker-session', value: 'synthetic-refresh', url: new URL(page.url()).origin, httpOnly: true, sameSite: 'Lax' }]);
  await page.evaluate(() => localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: {
    token: 'synthetic-access', refreshToken: null, isAuthenticated: true, user: { id: 'synthetic-member', username: 'synthetic' }, permissions: [],
  } })));
}
function ordinary(route: Route) {
  const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return respond(route, { apiKeys: [] });
  if (path.endsWith('/me')) return respond(route, identity);
  if (path.endsWith('/sessions')) return respond(route, []);
  if (path.endsWith('/oauth/connections')) return respond(route, { connections: [] });
  return respond(route, null, 503);
}

test.beforeEach(async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/')) return respond(route, null, 503);
    return route.continue();
  });
});

test('shows only configured providers and does not load Google before an explicit One Tap action', async ({ page }) => {
  let enabled = false; const external: string[] = [];
  page.on('request', req => { if (!req.url().startsWith(new URL(page.url()).origin)) external.push(req.url()); });
  await page.route('**/api/authorize/oauth/providers', route => respond(route, { providers: enabled ? [{ id: 'github', code: true }] : [] }));
  await page.goto('/en/login');
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in with Google One Tap' })).toHaveCount(0);
  enabled = true; await page.reload();
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  expect(external.filter(url => url.includes('accounts.google.com'))).toEqual([]);
});

test('starts a configured code flow with locale and a safe return path', async ({ page, context }) => {
  // Sign-in opens the provider in a popup; the popup page starts the flow, so routes are context-wide.
  const starts: unknown[] = [];
  await context.route('https://github.com/login/oauth/authorize?**', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic provider consent</p>' }));
  await context.route('**/api/authorize/oauth/providers', route => respond(route, { providers: [{ id: 'github', code: true }] }));
  await context.route('**/api/authorize/oauth/github/start', route => {
    starts.push(route.request().postDataJSON());
    return respond(route, { authorizationUrl: `https://github.com/login/oauth/authorize?state=${ticket}` }, 200,
      { 'set-cookie': 'zucker-oauth-browser=synthetic-browser; Path=/api/authorize/oauth; HttpOnly; SameSite=Lax' });
  });
  await page.goto('/en/login?redirect=%2Fen%2Faccount');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  const popup = await opened;
  await expect(popup).toHaveURL(new RegExp(`github.com/login/oauth/authorize\\?state=${ticket}`));
  expect(starts).toEqual([{ locale: 'en', mode: 'code', returnPath: '/account' }]);
  // The opener keeps its page while the popup is out.
  await expect(page).toHaveURL(/\/login\?redirect=/);
});

test('keeps callback proof in memory, waits for confirmation and installs only the returned account session', async ({ page }) => {
  const completions: unknown[] = [], external: string[] = [];
  page.on('request', request => { if (/https:\/\//.test(request.url())) external.push(request.url()); });
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return respond(route, { apiKeys: [] });
    if (path.endsWith('/oauth/providers')) return respond(route, { providers: [] });
    if (path.endsWith('/github/complete')) { completions.push(route.request().postDataJSON()); return respond(route, { token: 'synthetic-access', returnPath: '/account' }, 200, authCookie); }
    return ordinary(route);
  });
  await page.goto(`/en/oauth/callback?provider=github&purpose=login#ticket=${ticket}`);
  await expect(page).not.toHaveURL(/#ticket=/); expect(completions).toHaveLength(0);
  await expect(page.locator('script[id^="zucker-analytics-"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue signing in', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/); await expect(page.getByLabel('Display name')).toHaveValue('Synthetic member');
  expect(completions).toEqual([{ proof: ticket }]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(ticket);
  expect(external).toEqual([]);
});

test('explicit binding failure remains retryable and sends the current account authorization', async ({ page }) => {
  let failure = true; const calls: Array<{ body: unknown; authorization: string }> = [];
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return respond(route, { apiKeys: [] });
    if (path.endsWith('/oauth/providers')) return respond(route, { providers: [] });
    if (path.endsWith('/github/link/complete')) {
      calls.push({ body: route.request().postDataJSON(), authorization: route.request().headers().authorization });
      return respond(route, failure ? null : { success: true }, failure ? 503 : 200);
    }
    return ordinary(route);
  });
  await existingAccount(page); await page.goto(`/en/oauth/callback?provider=github&purpose=link#ticket=${ticket}`);
  await expect(page).not.toHaveURL(/#ticket=/); expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Confirm account connection', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  failure = false; await page.getByRole('button', { name: 'Confirm account connection', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  expect(calls).toEqual(Array(2).fill({ body: { proof: ticket }, authorization: 'Bearer synthetic-access' }));
});

test('One Tap uses the server nonce and sends credential only in a same-origin POST body', async ({ page }) => {
  const sent: Array<{ path: string; body: unknown }> = [];
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'application/javascript', body:
    'window.google={accounts:{id:{initialize(options){window.__googleOptions=options},prompt(){window.__googleOptions.callback({credential:"synthetic-id-token"})},cancel(){}}}};' }));
  await page.route('**/api/authorize/**', route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith('/oauth/providers')) return respond(route, { providers: [{ id: 'google', code: false, oneTapClientId: clientId }] });
    if (path.endsWith('/google/start')) return respond(route, { intent: ticket, nonce: 'server-created-nonce', clientId });
    if (path.endsWith('/google/onetap')) { expect(url.search).toBe(''); sent.push({ path, body: route.request().postDataJSON() }); return respond(route, { proof: ticket, provider: 'google', purpose: 'login' }); }
    if (path.endsWith('/google/complete')) return respond(route, { token: 'synthetic-access', returnPath: '/account' }, 200, authCookie);
    return ordinary(route);
  });
  await page.goto('/en/login'); await page.getByRole('button', { name: 'Sign in with Google One Tap' }).click();
  await expect(page).toHaveURL(/\/account$/);
  expect(sent).toEqual([{ path: '/api/authorize/oauth/google/onetap', body: { intent: ticket, credential: 'synthetic-id-token' } }]);
  expect(await page.evaluate(() => (Reflect.get(window, '__googleOptions') as { nonce: string }).nonce)).toBe('server-created-nonce');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('synthetic-id-token');
});

test('an unavailable One Tap prompt restores the provider choices', async ({ page }) => {
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'application/javascript', body:
    'window.google={accounts:{id:{initialize(){},prompt(callback){callback({isNotDisplayed:()=>true})},cancel(){}}}};' }));
  await page.route('**/api/authorize/oauth/providers', route => respond(route, { providers: [{ id: 'google', code: true, oneTapClientId: clientId }] }));
  await page.route('**/api/authorize/oauth/google/start', route => respond(route, { intent: ticket, nonce: 'server-created-nonce', clientId }));
  await page.goto('/en/login'); await page.getByRole('button', { name: 'Sign in with Google One Tap' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('unavailable in this browser');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
});

test('account connections start linking with the current authenticated session', async ({ page }) => {
  const starts: Array<{ body: unknown; authorization: string }> = [];
  await page.route('https://github.com/login/oauth/authorize?**', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic account consent</p>' }));
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return respond(route, { apiKeys: [] });
    if (path.endsWith('/oauth/providers')) return respond(route, { providers: [{ id: 'github', code: true }] });
    if (path.endsWith('/github/link/start')) { starts.push({ body: route.request().postDataJSON(), authorization: route.request().headers().authorization });
      return respond(route, { authorizationUrl: `https://github.com/login/oauth/authorize?state=${ticket}` }); }
    return ordinary(route);
  });
  await existingAccount(page); await page.goto('/en/account');
  await page.getByRole('region', { name: 'Connected sign-in accounts' }).getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(page).toHaveURL(/github.com\/login\/oauth\/authorize/);
  expect(starts).toEqual([{ body: { locale: 'en', mode: 'code', returnPath: '/account' }, authorization: 'Bearer synthetic-access' }]);
});

test('disconnect failure preserves the connection and revoking the current provider session signs out on retry', async ({ page }) => {
  let failure = true, disconnects = 0;
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return respond(route, { apiKeys: [] });
    if (path.endsWith('/oauth/providers')) return respond(route, { providers: [{ id: 'google', code: true }] });
    if (path.endsWith('/oauth/connections')) return respond(route, { connections: [{ provider: 'google', email: 'member@example.test' }] });
    if (path.endsWith('/connections/google')) { disconnects++; return failure ? respond(route, null, 503)
      : respond(route, { success: true, signedOut: true }, 200, { 'set-cookie': 'zucker-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' }); }
    return ordinary(route);
  });
  await existingAccount(page); await page.goto('/en/account');
  const section = page.getByRole('region', { name: 'Connected sign-in accounts' });
  await section.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Could not disconnect');
  await expect(section.getByText('member@example.test')).toBeVisible();
  failure = false; await section.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/); expect(disconnects).toBe(2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state.isAuthenticated)).toBe(false);
});

test('Chinese default-locale registration and password sign-in use canonical routes without loops', async ({ page, baseURL }) => {
  const registrations: unknown[] = [];
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: baseURL! }]);
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return respond(route, { apiKeys: [] });
    if (path.endsWith('/oauth/providers')) return respond(route, { providers: [] });
    if (path.endsWith('/register')) { registrations.push(route.request().postDataJSON()); return respond(route, { verificationRequired: true }); }
    if (path.endsWith('/login')) return respond(route, { userId: identity.id, token: 'synthetic-access' }, 200, authCookie);
    return ordinary(route);
  });
  await page.goto('/zh/register'); await expect(page).toHaveURL(/\/register$/);
  await page.getByLabel('用户名', { exact: true }).fill('synthetic');
  await page.getByLabel('邮箱', { exact: true }).fill('member@example.test');
  await page.getByLabel('密码', { exact: true }).fill('Synthetic123');
  await page.getByLabel('确认密码', { exact: true }).fill('Synthetic123');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
  expect(registrations).toEqual([{ username: 'synthetic', email: 'member@example.test', password: 'Synthetic123', locale: 'zh' }]);
  await page.goto('/zh/login?redirect=%2Fzh%2Faccount');
  await page.getByLabel('用户名', { exact: true }).fill('synthetic'); await page.getByLabel('密码', { exact: true }).fill('Synthetic123');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/); await expect(page.getByRole('heading', { name: '我的账户' })).toBeVisible();
  await expect(page.getByLabel('显示名称')).toHaveValue('Synthetic member');
});

test('Chinese OAuth callback preserves its fragment through canonical redirect and completes in Chinese', async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: baseURL! }]);
  await page.route('**/api/authorize/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/authorize/api-keys') && route.request().method() === 'GET') return respond(route, { apiKeys: [] });
    if (path.endsWith('/oauth/providers')) return respond(route, { providers: [] });
    if (path.endsWith('/github/complete')) { expect(route.request().postDataJSON()).toEqual({ proof: ticket }); return respond(route, { token: 'synthetic-access', returnPath: '/account' }, 200, authCookie); }
    return ordinary(route);
  });
  await page.goto(`/zh/oauth/callback?provider=github&purpose=login#ticket=${ticket}`);
  await expect(page).not.toHaveURL(/#ticket=/);
  await page.getByRole('button', { name: '继续登录', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/); await expect(page.getByRole('heading', { name: '我的账户' })).toBeVisible();
  await expect(page.locator('script[id^="zucker-analytics-"]')).toHaveCount(0);
});
