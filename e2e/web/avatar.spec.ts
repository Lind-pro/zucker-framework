import { test, expect, type Page, type Route } from '@playwright/test';
import { avatarPng } from './avatar-fixture';

const png = Buffer.from(avatarPng, 'base64');
const identity = { id: 'synthetic-owner', username: 'synthetic', name: 'Synthetic member', email: 'member@example.invalid', emailVerified: true, permissions: [] };
const respond = (route: Route, result: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ status, message: status < 400 ? 'success' : 'Synthetic failure', result }) });
async function open(page: Page, baseURL: string, locale = 'en') {
  await page.context().addCookies([{ name: 'zucker-session', value: 'synthetic-cookie', url: baseURL, httpOnly: true, sameSite: 'Lax' }, { name: 'NEXT_LOCALE', value: locale, url: baseURL }]);
  await page.addInitScript(() => {
    localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: { token: 'synthetic-access', refreshToken: null, isAuthenticated: true,
      user: { id: 'synthetic-owner', username: 'synthetic' }, permissions: [] } }));
    const revoke = URL.revokeObjectURL.bind(URL), revoked: string[] = [];
    Reflect.set(window, '__avatarRevokedUrls', revoked); URL.revokeObjectURL = value => { revoked.push(value); revoke(value); };
  });
  await page.goto(locale === 'zh' ? '/account' : '/en/account');
}

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || new URL(baseURL).hostname !== 'localhost') throw new Error('Avatar browser checks require localhost');
  const origin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.endsWith('/authorize/me')) return respond(route, identity);
    if (url.pathname.endsWith('/authorize/sessions')) return respond(route, []);
    if (url.pathname.endsWith('/authorize/api-keys')) return respond(route, { apiKeys: [] });
    if (url.pathname.endsWith('/oauth/providers')) return respond(route, { providers: [] });
    if (url.pathname.endsWith('/oauth/connections')) return respond(route, { connections: [] });
    return respond(route, null, 503);
  });
});

test('retries uncertain upload and removal with stable keys and never persists private image URLs', async ({ page, baseURL }) => {
  const uploads: Array<{ key?: string; match?: string; type?: string }> = [], removals: Array<{ key?: string; match?: string }> = [];
  let saved = false, removed = false;
  await page.route('**/api/authorize/avatar', route => {
    const headers = route.request().headers(), method = route.request().method();
    if (method === 'GET') return respond(route, { assetId: saved && !removed ? 'owned-avatar' : null, revision: removed ? 2 : saved ? 1 : 0 });
    if (method === 'POST') {
      uploads.push({ key: headers['idempotency-key'], match: headers['if-match'], type: headers['content-type'] }); saved = true;
      return uploads.length === 1 ? respond(route, null, 503) : respond(route, { assetId: 'owned-avatar', revision: 1, appliedRevision: 1 });
    }
    removals.push({ key: headers['idempotency-key'], match: headers['if-match'] }); removed = true;
    return removals.length === 1 ? respond(route, null, 503) : respond(route, { assetId: null, revision: 2, appliedRevision: 2 });
  });
  await page.route('**/api/authorize/avatar/content?**', route => route.fulfill({ contentType: 'image/png', body: png }));
  await open(page, baseURL!); const section = page.getByRole('region', { name: 'Profile photo', exact: true });
  await section.getByLabel('Choose a photo').setInputFiles({ name: 'synthetic-avatar.png', mimeType: 'image/png', buffer: png });
  await section.getByRole('button', { name: 'Save photo', exact: true }).click(); await expect(section.getByRole('alert')).toContainText('Your selected file is kept');
  expect(await section.getByLabel('Choose a photo').evaluate(element => (element as HTMLInputElement).files?.length)).toBe(1);
  await section.getByRole('button', { name: 'Save photo', exact: true }).click();
  await expect(section.getByRole('img', { name: 'Your profile photo' })).toHaveJSProperty('naturalWidth', 32);
  expect(uploads).toHaveLength(2); expect(uploads[0].key).toBe(uploads[1].key); expect(uploads[0].match).toBe('"0"'); expect(uploads[1].match).toBe('"0"');
  expect(uploads[0].type).toMatch(/multipart\/form-data; boundary=/);
  expect(await page.evaluate(() => JSON.stringify(localStorage).includes('blob:'))).toBe(false);
  await section.getByRole('button', { name: 'Remove photo', exact: true }).click(); await expect(section.getByRole('alert')).toContainText('Could not confirm removal');
  await section.getByRole('button', { name: 'Remove photo', exact: true }).click(); await expect(section.getByText('No profile photo is set.')).toBeVisible();
  expect(removals[0].key).toBe(removals[1].key); expect(removals.map(item => item.match)).toEqual(['"1"', '"1"']);
  expect(await page.evaluate(() => (Reflect.get(window, '__avatarRevokedUrls') as string[]).some(value => value.startsWith('blob:')))).toBe(true);
});

test('recovers a stale revision by loading the newer photo before an explicit retry', async ({ page, baseURL }) => {
  let current = { assetId: null as string | null, revision: 0 }; const writes: Array<Record<string, string>> = [];
  await page.route('**/api/authorize/avatar', route => {
    if (route.request().method() === 'GET') return respond(route, current);
    writes.push(route.request().headers());
    if (writes.length === 1) { current = { assetId: 'other-window-avatar', revision: 1 }; return respond(route, null, 409); }
    current = { assetId: 'new-owned-avatar', revision: 2 }; return respond(route, { ...current, appliedRevision: 2 });
  });
  await page.route('**/api/authorize/avatar/content?**', route => route.fulfill({ contentType: 'image/png', body: png }));
  await open(page, baseURL!); const section = page.getByRole('region', { name: 'Profile photo', exact: true });
  await section.getByLabel('Choose a photo').setInputFiles({ name: 'new-avatar.png', mimeType: 'image/png', buffer: png });
  await section.getByRole('button', { name: 'Save photo', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('changed in another window');
  await expect(section.getByRole('img')).toHaveJSProperty('naturalWidth', 32);
  await section.getByRole('button', { name: 'Save photo', exact: true }).click();
  await expect(section.getByRole('status')).toHaveText('Profile photo saved.');
  expect(writes.map(item => item['if-match'])).toEqual(['"0"', '"1"']); expect(writes[0]['idempotency-key']).not.toBe(writes[1]['idempotency-key']);
});

test('keeps profile editing usable during avatar failures and renders the recovered Chinese panel on mobile', async ({ page, baseURL }) => {
  let failure = true;
  await page.route('**/api/authorize/avatar', route => route.request().method() === 'GET'
    ? respond(route, { assetId: null, revision: 0 }, failure ? 503 : 200) : respond(route, null, 400));
  await page.setViewportSize({ width: 390, height: 844 }); await open(page, baseURL!, 'zh');
  const section = page.getByRole('region', { name: '个人头像', exact: true });
  await expect(section.getByRole('alert')).toHaveText('未能加载头像，请重试。'); await expect(page.getByLabel('显示名称')).toHaveValue('Synthetic member');
  failure = false; await section.getByRole('button', { name: '重试', exact: true }).click();
  await expect(section.getByText('尚未设置头像。')).toBeVisible();
  await section.getByLabel('选择头像图片').setInputFiles({ name: 'invalid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(section.getByRole('alert')).toContainText('请选择一张'); await expect(section.getByRole('button', { name: '保存头像', exact: true })).toBeDisabled();
  await section.getByLabel('选择头像图片').setInputFiles({ name: 'rejected.png', mimeType: 'image/png', buffer: png });
  await section.getByRole('button', { name: '保存头像', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('这张图片无法使用'); await expect(section.getByRole('button', { name: '保存头像', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await section.screenshot({ path: '/private/tmp/zucker-avatar-mobile-20261024.png' });
});
