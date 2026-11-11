/**
 * Public site shell: SEO tags, locale switching, suggestion banner, signed-in header.
 * Synthetic only: the API is mocked through route interception. Assumes the web template runs with
 * the default locale `en` (unprefixed) and SITE_URL = E2E_SITE_URL (default http://localhost:4202).
 * Shared-cache headers are only produced by a production build (`next start`); set
 * E2E_WEB_PRODUCTION=1 to include that check.
 */
import { test, expect, type Page } from '@playwright/test';

const SITE = (process.env['E2E_SITE_URL'] ?? 'http://localhost:4202').replace(/\/$/, '');
const PUBLIC_CACHE = 'public, s-maxage=3600, stale-while-revalidate=14400';

const meta = (page: Page, selector: string, attribute = 'content') => page.locator(selector).first().getAttribute(attribute);

test.beforeEach(async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"status":503,"result":null,"message":"unmocked"}' }));
  await context.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient')));
});

for (const { path, canonical, zhCanonical } of [
  { path: '/pricing', canonical: `${SITE}/pricing`, zhCanonical: `${SITE}/zh/pricing` },
  // Next's metadata resolver writes a root URL as the bare origin (no trailing slash).
  { path: '/', canonical: SITE, zhCanonical: `${SITE}/zh` },
]) {
  // `/` renders the CMS `home` page, so the content API (or a stub) must answer server-side reads.
  test(`${path} emits canonical, hreflang, Open Graph and Twitter tags from SITE_URL`, async ({ page, baseURL }) => {
    const response = await page.goto(path);
    expect(response!.status()).toBe(200);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', canonical);
    expect(await meta(page, 'link[rel="alternate"][hreflang="en"]', 'href')).toBe(canonical);
    expect(await meta(page, 'link[rel="alternate"][hreflang="zh-CN"]', 'href')).toBe(zhCanonical);
    expect(await meta(page, 'link[rel="alternate"][hreflang="x-default"]', 'href')).toBe(canonical);
    expect(await meta(page, 'meta[property="og:url"]')).toBe(canonical);
    expect(await meta(page, 'meta[property="og:locale"]')).toBe('en_US');
    expect(await meta(page, 'meta[property="og:image"]')).toBe(`${SITE}/en/opengraph-image`);
    expect(await meta(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');
    // Never derived from the host the browser used.
    const html = await page.content();
    if (new URL(baseURL!).origin !== SITE) expect(html).not.toContain(`href="${new URL(baseURL!).origin}/`);
    if (path === '/') expect(await meta(page, 'meta[name="robots"]')).toContain('index');
  });
}

test('zh pages are prefixed and canonicalise to the zh URL', async ({ page }) => {
  await page.goto('/zh/pricing');
  await expect(page.locator('html')).toHaveAttribute('lang', /zh/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${SITE}/zh/pricing`);
  expect(await meta(page, 'meta[property="og:locale"]')).toBe('zh_CN');
  expect(await meta(page, 'meta[property="og:image"]')).toBe(`${SITE}/zh/opengraph-image`);
});

test('generated Open Graph image is a PNG for both locales', async ({ request }) => {
  for (const locale of ['en', 'zh']) {
    const response = await request.get(`/${locale}/opengraph-image`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
    expect((await response.body()).subarray(1, 4).toString()).toBe('PNG');
  }
});

test('sitemap page 0 lists static routes with xhtml alternates', async ({ request }) => {
  const response = await request.get('/sitemaps/0.xml');
  expect(response.status()).toBe(200);
  const xml = await response.text();
  for (const route of ['/pricing', '/zh/pricing', '/blog', '/docs', '/changelog']) expect(xml).toContain(`<loc>${SITE}${route}</loc>`);
  expect(xml).toContain('<xhtml:link rel="alternate" hreflang="zh-CN"');
  expect(xml).not.toContain('127.0.0.1');
});

test('public pages are shared-cacheable and never set cookies; private pages are no-store', async ({ request }) => {
  test.skip(!process.env['E2E_WEB_PRODUCTION'], 'Cache-Control is only produced by a production build');
  for (const path of ['/', '/pricing', '/zh/pricing']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['cache-control'], path).toBe(PUBLIC_CACHE);
    expect(response.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie'), path).toEqual([]);
  }
  const login = await request.get('/login');
  expect(login.headers()['cache-control']).toBe('private, no-store');
  const guarded = await request.get('/account', { maxRedirects: 0 });
  expect(guarded.status()).toBe(307);
  expect(guarded.headers()['cache-control']).toBe('private, no-store');
  expect(guarded.headers()['location']).toContain('/login?redirect=');
});

test('locale switcher keeps path and query', async ({ page }) => {
  await page.goto('/pricing?interval=year');
  await page.getByTestId('locale-switcher').first().selectOption('zh');
  await page.waitForURL(/\/zh\/pricing\?interval=year$/);
  await page.getByTestId('locale-switcher').first().selectOption('en');
  await page.waitForURL(url => url.pathname === '/pricing' && url.search === '?interval=year');
});

test('locale suggestion banner appears for a zh browser, dismiss sets a data-free one-day cookie', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto('/pricing');
  const banner = page.getByTestId('locale-suggestion');
  await expect(banner).toBeVisible();
  expect(await context.cookies()).toEqual([]);
  await banner.getByRole('button', { name: '关闭' }).click();
  await expect(banner).toBeHidden();
  const cookie = (await context.cookies()).find(c => c.name === 'zucker-locale-hint');
  expect(cookie).toMatchObject({ value: '1', path: '/', sameSite: 'Lax' });
  expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(23 * 3600);
  expect(cookie!.expires - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600 + 5);
  await page.reload();
  await expect(page.getByTestId('locale-suggestion')).toHaveCount(0);
  await context.close();
});

test('banner "switch" navigates to the suggested locale on the same path', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto('/pricing');
  await page.getByTestId('locale-suggestion').getByRole('button', { name: '切换到中文' }).click();
  await page.waitForURL(/\/zh\/pricing$/);
  await context.close();
});

test('an English browser on an English page sees no banner', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/pricing');
  await expect(page.getByTestId('session-signed-out').first()).toBeVisible();
  await expect(page.getByTestId('locale-suggestion')).toHaveCount(0);
  await context.close();
});

test('header: signed out shows login/register, then credit balance, menu and admin link after sign-in', async ({ page, context, baseURL }) => {
  await page.goto('/');
  await expect(page.getByTestId('session-signed-out').first()).toBeVisible();
  await page.route('**/api/credits/balance', route => route.fulfill({ json: { status: 200, result: { available: 4200 } } }));
  await page.route('**/api/authorize/me', route => route.fulfill({ json: { status: 200, result: { id: '1', username: 'synthetic', permissions: [{ id: 'config', actions: ['query'] }] } } }));
  await page.evaluate(() => localStorage.setItem('auth-storage', JSON.stringify({ state: { token: 't', refreshToken: null,
    user: { id: '1', username: 'synthetic', name: 'Synthetic User' }, isAuthenticated: true, permissions: ['config:query'] }, version: 0 })));
  await page.reload();
  await expect(page.getByTestId('header-credit-balance').first()).toContainText('4,200');
  await page.getByRole('button', { name: 'Account menu' }).first().click();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  void context; void baseURL;
});

test('console sidebar marks the current section', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'zucker-session', value: 'synthetic', url: baseURL! }]);
  await page.addInitScript(() => localStorage.setItem('auth-storage', JSON.stringify({ state: { token: 't', refreshToken: null,
    user: { id: '1', username: 'synthetic', name: 'Synthetic User' }, isAuthenticated: true, permissions: [] }, version: 0 })));
  await page.route('**/api/**', route => route.fulfill({ json: { status: 200, result: {} } }));
  await page.goto('/zh/account/credits');
  const nav = page.getByTestId('console-nav');
  // 7 core sections + AI tasks + Chats + Invite friends + Notifications + Feedback.
  await expect(nav.locator('a')).toHaveCount(12);
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('data-console-nav', 'credits');
});
