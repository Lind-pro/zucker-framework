import { test, expect, type Page, type Route } from '@playwright/test';

const secret = `zk_api_${'s'.repeat(32)}`;
const identity = { id: 'synthetic-owner', username: 'synthetic', name: 'Synthetic member', email: 'member@example.test', emailVerified: true, permissions: [] };
const key = { id: 'synthetic-key', name: 'Command line', keyPrefix: 'zk_api_sssss...', scopes: ['account:read'],
  expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), createdAt: new Date().toISOString(), usageCount: 0, lastUsedAt: null, isActive: true };
const respond = (route: Route, result: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? result : { status, result, message: 'Synthetic failure' }) });
async function openAccount(page: Page, baseURL: string, locale = 'en', knownOwner = true) {
  await page.context().addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }, { name: 'NEXT_LOCALE', value: locale, url: baseURL }]);
  await page.addInitScript((known: boolean) => localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: {
    token: 'synthetic-access', refreshToken: null, isAuthenticated: true, user: known ? { id: 'synthetic-owner', username: 'synthetic' } : null, permissions: [],
  } })), knownOwner);
  await page.goto(locale === 'zh' ? '/zh/account' : '/en/account');
}

test.beforeEach(async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.endsWith('/authorize/me')) return respond(route, identity);
    if (url.pathname.endsWith('/authorize/sessions')) return respond(route, []);
    if (url.pathname.endsWith('/oauth/providers')) return respond(route, { providers: [] });
    if (url.pathname.endsWith('/oauth/connections')) return respond(route, { connections: [] });
    if (url.pathname.endsWith('/billing/catalog')) return respond(route, { offers: [] });
    return respond(route, null, 503);
  });
});

test('creates a scoped key, displays/copies it once and never persists it or puts it in a request URL', async ({ page, baseURL }) => {
  let created = false; const bodies: unknown[] = [], urls: string[] = [];
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (value: string) => { Reflect.set(window, '__syntheticCopied', value); },
  } }));
  page.on('request', request => urls.push(request.url()));
  await page.route('**/api/authorize/api-keys', route => {
    if (route.request().method() === 'GET') return respond(route, { apiKeys: created ? [key] : [] });
    bodies.push(route.request().postDataJSON()); created = true; return respond(route, { apiKey: key, secretKey: secret }, 201);
  });
  await openAccount(page, baseURL!); const section = page.getByRole('region', { name: 'API keys', exact: true });
  await section.getByLabel('Key name').fill('Command line');
  await section.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(section.getByLabel('New API key', { exact: true })).toHaveValue(secret);
  await expect(section.getByRole('button', { name: 'Copy key', exact: true })).toBeFocused();
  await section.getByRole('button', { name: 'Copy key', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, '__syntheticCopied'))).toBe(secret);
  expect(bodies).toEqual([{ name: 'Command line', expiresInDays: 30, scopes: ['account:read'] }]);
  expect(await page.evaluate(() => JSON.stringify(localStorage).includes('zk_api_'))).toBe(false);
  expect(urls.some(url => url.includes(secret))).toBe(false);
  await section.getByRole('button', { name: 'I saved this key' }).click();
  await expect(section.getByLabel('New API key', { exact: true })).toHaveCount(0);
  await expect(section.getByText(key.keyPrefix)).toBeVisible();
  await page.reload(); await expect(section.getByText(key.keyPrefix)).toBeVisible();
  await expect(section.getByLabel('New API key', { exact: true })).toHaveCount(0);
});

test('key-list failure is local to its panel and can be retried', async ({ page, baseURL }) => {
  let unavailable = true;
  await page.route('**/api/authorize/api-keys', route => unavailable ? respond(route, null, 503) : respond(route, { apiKeys: [key] }));
  await openAccount(page, baseURL!); const section = page.getByRole('region', { name: 'API keys', exact: true });
  await expect(section.getByRole('alert')).toContainText('Could not load your keys');
  await expect(page.getByLabel('Display name')).toHaveValue('Synthetic member');
  unavailable = false; await section.getByRole('button', { name: 'Retry' }).click();
  await expect(section.getByText(key.name, { exact: true })).toBeVisible(); await expect(section.getByRole('alert')).toHaveCount(0);
});

test('creation failure keeps form input and a successful retry reveals only the new secret', async ({ page, baseURL }) => {
  let unavailable = true, created = false;
  await page.route('**/api/authorize/api-keys', route => {
    if (route.request().method() === 'GET') return respond(route, { apiKeys: created ? [key] : [] });
    if (unavailable) return respond(route, null, 503);
    created = true; return respond(route, { apiKey: key, secretKey: secret }, 201);
  });
  await openAccount(page, baseURL!); const section = page.getByRole('region', { name: 'API keys', exact: true });
  await section.getByLabel('Key name').fill('Command line'); await section.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Could not create the key');
  await expect(section.getByLabel('Key name')).toHaveValue('Command line'); await expect(section.getByLabel('New API key', { exact: true })).toHaveCount(0);
  unavailable = false; await section.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(section.getByLabel('New API key', { exact: true })).toHaveValue(secret);
});

test('failed revocation preserves the key and a retry removes both metadata and the new-secret view', async ({ page, baseURL }) => {
  let created = false, failure = true, revokes = 0;
  await page.route('**/api/authorize/api-keys', route => {
    if (route.request().method() === 'GET') return respond(route, { apiKeys: created ? [key] : [] });
    created = true; return respond(route, { apiKey: key, secretKey: secret }, 201);
  });
  await page.route('**/api/authorize/api-keys/synthetic-key', route => {
    revokes++; if (failure) return respond(route, null, 503);
    created = false; return respond(route, { success: true });
  });
  await openAccount(page, baseURL!); const section = page.getByRole('region', { name: 'API keys', exact: true });
  await section.getByLabel('Key name').fill('Command line'); await section.getByRole('button', { name: 'Create key', exact: true }).click();
  await section.getByRole('button', { name: 'Revoke Command line', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Could not revoke this key');
  await expect(section.getByLabel('New API key', { exact: true })).toHaveValue(secret);
  failure = false; await section.getByRole('button', { name: 'Revoke Command line', exact: true }).click();
  await expect(section.getByText('You have no active API keys.')).toBeVisible();
  await expect(section.getByLabel('New API key', { exact: true })).toHaveCount(0); expect(revokes).toBe(2);
});

test('Chinese key management keeps readable labels and sends the chosen expiry with the fixed read scope', async ({ page, baseURL }) => {
  const bodies: unknown[] = [];
  await page.route('**/api/authorize/api-keys', route => {
    if (route.request().method() === 'GET') return respond(route, { apiKeys: [] });
    bodies.push(route.request().postDataJSON()); return respond(route, { apiKey: { ...key, name: '命令行客户端' }, secretKey: secret }, 201);
  });
  await openAccount(page, baseURL!, 'zh'); const section = page.getByRole('region', { name: 'API 密钥', exact: true });
  await section.getByLabel('密钥名称').fill('命令行客户端'); await section.getByLabel('有效期').selectOption('90');
  await section.getByRole('button', { name: '创建密钥', exact: true }).click();
  await expect(section.getByLabel('新 API 密钥', { exact: true })).toHaveValue(secret);
  expect(bodies).toEqual([{ name: '命令行客户端', expiresInDays: 90, scopes: ['account:read'] }]);
  await section.getByRole('button', { name: '我已保存密钥' }).click();
  await expect(section.getByLabel('新 API 密钥', { exact: true })).toHaveCount(0);
});


test('waits for a delayed account identity before allowing creation so the one-time secret survives', async ({ page, baseURL }) => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let lists = 0, created = false;
  await page.route('**/api/authorize/me', async route => { await pending; return respond(route, identity); });
  await page.route('**/api/authorize/api-keys', route => {
    if (route.request().method() === 'GET') { lists++; return respond(route, { apiKeys: created ? [key] : [] }); }
    created = true; return respond(route, { apiKey: key, secretKey: secret }, 201);
  });
  await openAccount(page, baseURL!, 'en', false);
  const section = page.getByRole('region', { name: 'API keys', exact: true });
  await expect(section.getByText('Loading API keys…')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Create key', exact: true })).toHaveCount(0); expect(lists).toBe(0);
  release(); await section.getByLabel('Key name').fill('Command line');
  await section.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(section.getByLabel('New API key', { exact: true })).toHaveValue(secret);
  await expect(page.getByLabel('Display name')).toHaveValue('Synthetic member');
});

test('renames only the key name and retains a failed draft for a successful retry', async ({ page, baseURL }) => {
  let currentName = key.name, failing = true; const requests: unknown[] = [];
  await page.route('**/api/authorize/api-keys', route => respond(route, { apiKeys: [{ ...key, name: currentName, canRename: true }] }));
  await page.route('**/api/authorize/api-keys/synthetic-key', route => {
    expect(route.request().method()).toBe('PATCH'); requests.push(route.request().postDataJSON());
    if (failing) return respond(route, null, 503);
    currentName = route.request().postDataJSON().name; return respond(route, { id: key.id, name: currentName });
  });
  await openAccount(page, baseURL!); const section = page.getByRole('region', { name: 'API keys', exact: true });
  await section.getByRole('button', { name: 'Rename Command line', exact: true }).click();
  await expect(section.getByLabel('New key name')).toBeFocused();
  await section.getByLabel('New key name').fill('Deployment client'); await section.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Could not rename this key'); await expect(section.getByLabel('New key name')).toHaveValue('Deployment client');
  await expect(section.getByText('Command line', { exact: true })).toBeVisible(); await expect(section.getByText(key.keyPrefix, { exact: true })).toBeVisible();
  failing = false; await section.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(section.getByText('Deployment client', { exact: true })).toBeVisible(); await expect(section.getByLabel('New key name')).toHaveCount(0);
  expect(requests).toEqual([{ name: 'Deployment client' }, { name: 'Deployment client' }]);
  await expect(section.getByLabel('New API key', { exact: true })).toHaveCount(0);
  await page.reload(); await expect(section.getByText('Deployment client', { exact: true })).toBeVisible();
});

test('does not offer a live rename action for expired or disabled keys', async ({ page, baseURL }) => {
  await page.route('**/api/authorize/api-keys', route => respond(route, { apiKeys: [
    { ...key, name: 'Expired client', expiresAt: '2000-01-01T00:00:00Z', canRename: false },
    { ...key, id: 'disabled-key', name: 'Disabled client', isActive: false, canRename: false },
  ] }));
  await openAccount(page, baseURL!); const section = page.getByRole('region', { name: 'API keys', exact: true });
  await expect(section.getByRole('button', { name: 'Rename Expired client', exact: true })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Rename Disabled client', exact: true })).toBeDisabled();
});
