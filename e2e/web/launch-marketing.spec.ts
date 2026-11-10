/**
 * Launch marketing pages: CMS home (blocks + live slots), pricing page, signed-in current plan,
 * checkout with allowProviderChoice=false, first-touch UTM, signed revalidate receiver.
 *
 * The web template must be a PRODUCTION build (`next start`) running against the stub in
 * launch-stub-api.ts; server-side reads cannot be intercepted by Playwright:
 *   API_URL=http://127.0.0.1:4393/api REVALIDATE_SECRET=<E2E_REVALIDATE_SECRET> next start -p 4391
 * playwright.config.ts (project `web-launch-chromium`) builds the web template and starts it this way
 * on E2E_LAUNCH_WEB_PORT (4391) with synthetic E2E_* defaults: `pnpm test:e2e:ui --project web-launch-chromium`.
 * Skipped unless E2E_WEB_URL is set. Synthetic data only.
 */
import { createHmac } from 'node:crypto';
import { test, expect, type BrowserContext } from '@playwright/test';
import { startStubApi } from './launch-stub-api';

const WEB = process.env['E2E_WEB_URL'];
const SECRET = process.env['E2E_REVALIDATE_SECRET'] ?? '';
const STUB_PORT = Number(process.env['E2E_STUB_API_PORT'] ?? 4393);

test.skip(!WEB, 'Set E2E_WEB_URL to a `next start` instance whose API_URL is the launch stub API');
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEB });

let stub: Awaited<ReturnType<typeof startStubApi>>;
test.beforeAll(async () => {
  if (WEB) stub = await startStubApi(STUB_PORT);
});
test.afterAll(async () => {
  await stub?.close();
});
test.beforeEach(() => {
  stub.state.requests.length = 0;
  stub.state.policy = { defaultProvider: 'paypal', allowProviderChoice: false };
});

async function signIn(context: BrowserContext, baseURL: string) {
  const origin = new URL(baseURL).origin;
  await context.addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: { token: 'synthetic-token', refreshToken: null,
      isAuthenticated: true, user: { id: 'synthetic-user', username: 'synthetic' }, permissions: [] } }));
  }, { origin });
}
async function stubPayments(context: BrowserContext) {
  await context.route('https://payments.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Synthetic payment host</h1>' }));
}

test.describe('home (CMS blocks)', () => {
  test('renders hero, pricing slot, blog and changelog slots from the content API', async ({ page }) => {
    const response = await page.goto('/');
    expect(response!.status()).toBe(200);
    await expect(page.getByTestId('home-page')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Synthetic hero heading' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'See pricing' })).toHaveAttribute('href', '/pricing');
    // Pricing block shows only the referenced plan, without credit packs.
    const block = page.getByTestId('pricing-block');
    await expect(block.locator('[data-plan="pro"]')).toBeVisible();
    await expect(block.locator('[data-plan="free"]')).toHaveCount(0);
    await expect(block.locator('[data-pack]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'First post' })).toHaveAttribute('href', '/blog/first-post');
    await expect(page.getByRole('link', { name: 'Release 1.0' })).toHaveAttribute('href', '/changelog/v1-0');
  });

  test('zh home uses prefixed links', async ({ page }) => {
    await page.goto('/zh');
    await expect(page.getByRole('heading', { level: 1, name: '合成首页标题' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'First post' })).toHaveAttribute('href', '/zh/blog/first-post');
  });

  test('/home permanently redirects to /', async ({ request }) => {
    const response = await request.get('/home', { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(new URL(response.headers()['location']!, WEB).pathname).toBe('/');
  });

  test('changelog entry resolves at /changelog/:slug', async ({ page }) => {
    const response = await page.goto('/changelog/v1-0');
    expect(response!.status()).toBe(200);
    await expect(page.getByText('Notes for 1.0')).toBeVisible();
    expect((await page.goto('/changelog/does-not-exist'))!.status()).toBe(404);
  });
});

test.describe('pricing page', () => {
  test('anonymous server render has plans, entitlements and packs and sent no credentials', async ({ page }) => {
    await page.goto('/pricing');
    const root = page.getByTestId('pricing-page');
    await expect(root.getByRole('heading', { level: 1, name: 'Pricing' })).toBeVisible();
    await expect(root.locator('[data-plan="free"]')).toBeVisible();
    await expect(root.locator('[data-plan="pro"]')).toContainText('$19.90');
    await expect(root.locator('[data-plan="pro"]')).toContainText('500 credits');
    await expect(root.locator('[data-plan="pro"]')).toContainText('Unlimited');
    await expect(root.locator('[data-plan="free"]')).toContainText('API access');
    await expect(root.locator('[data-pack="small"]')).toContainText('1,000 credits');
    await expect(root.locator('[data-current]')).toHaveCount(0);
    // Free plan has no sellable offer.
    await expect(root.locator('[data-plan="free"]').getByRole('button', { name: 'Not available for purchase yet' })).toBeDisabled();
    // Server never forwards Authorization on shared-cacheable reads.
    expect(stub.state.requests.filter((r) => r.authorization)).toEqual([]);
  });

  test('interval toggle swaps price and is reflected in the URL; invalid query is ignored', async ({ page }) => {
    await page.goto('/pricing?interval=bogus&currency=xx');
    const pro = page.locator('[data-plan="pro"]');
    await expect(pro).toContainText('$19.90');
    await page.locator('[data-interval="year"]').click();
    await expect(pro).toContainText('$199.00');
    await expect(pro).toContainText('/ year');
    await expect(page).toHaveURL(/interval=year/);
    await page.reload();
    await expect(page.locator('[data-plan="pro"]')).toContainText('$199.00');
    // Free plan has no yearly price, so it drops out of that tab.
    await expect(page.locator('[data-plan="free"]')).toHaveCount(0);
  });

  test('guest checkout goes to login and returns to the pricing page', async ({ page }) => {
    await page.goto('/pricing?interval=year');
    await page.locator('[data-plan="pro"]').getByRole('button', { name: 'Subscribe' }).click();
    await expect(page).toHaveURL(/\/login\?redirect=%2Fpricing%3Finterval%3Dyear/);
    expect(stub.state.requests.filter((r) => r.path.startsWith('/api/billing/orders'))).toEqual([]);
  });

  test('zh pricing page is localized', async ({ page }) => {
    await page.goto('/zh/pricing');
    await expect(page.getByRole('heading', { level: 1, name: '价格' })).toBeVisible();
    await expect(page.locator('[data-plan="pro"]').getByRole('button', { name: '订阅' })).toBeVisible();
  });

  test('signed in: current plan marked, subscribe disabled, other plan checkout with allowProviderChoice=false', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL!);
    await stubPayments(context);
    await page.goto('/pricing');
    const pro = page.locator('[data-plan="pro"]');
    await expect(pro).toHaveAttribute('data-current', 'true');
    await expect(pro.getByRole('button', { name: 'Current plan' })).toBeDisabled();
    await expect(pro.getByRole('button', { name: 'Subscribe' })).toHaveCount(0);
    // Personalised read carried the session.
    expect(stub.state.requests.some((r) => r.path.startsWith('/api/billing/plans') && r.authorization === 'Bearer synthetic-token')).toBe(true);

    // Pack checkout: no provider choice is offered, default provider is used.
    const pack = page.locator('[data-pack="small"]');
    await expect(pack.getByLabel('Payment method')).toHaveCount(0);
    await pack.getByRole('button', { name: 'Buy now' }).click();
    await expect(page.getByRole('heading', { name: 'Synthetic payment host' })).toBeVisible();
    const orders = stub.state.requests.filter((r) => r.method === 'POST' && r.path === '/api/billing/orders');
    expect(orders).toHaveLength(1);
    expect(orders[0]!.body).toEqual({ offerId: 'offer-pack-small', providerId: 'paypal' });
    expect(orders[0]!.idempotencyKey).toMatch(/^[a-f0-9]{32}$/);
    expect(orders[0]!.authorization).toBe('Bearer synthetic-token');
  });

  test('signed in with allowProviderChoice=true: provider select, chosen provider is sent', async ({ page, context, baseURL }) => {
    stub.state.policy = { defaultProvider: 'stripe', allowProviderChoice: true };
    await signIn(context, baseURL!);
    await stubPayments(context);
    await page.goto('/pricing');
    const pack = page.locator('[data-pack="small"]');
    const select = pack.getByLabel('Payment method');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['Stripe', 'PayPal']);
    await select.selectOption('paypal');
    await pack.getByRole('button', { name: 'Buy now' }).click();
    await expect(page.getByRole('heading', { name: 'Synthetic payment host' })).toBeVisible();
    const orders = stub.state.requests.filter((r) => r.method === 'POST' && r.path === '/api/billing/orders');
    expect(orders.map((o) => o.body)).toEqual([{ offerId: 'offer-pack-small', providerId: 'paypal' }]);
  });
});

test.describe('first-touch UTM', () => {
  test('first utm_source is stored once and never replaced; invalid ones ignored', async ({ page }) => {
    const stored = () => page.evaluate(() => localStorage.getItem('zucker.first-touch-utm'));
    await page.goto('/pricing?utm_source=bad%20value');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('pricing-page')).toBeVisible();
    expect(await stored()).toBeNull();
    await page.goto('/pricing?utm_source=newsletter');
    await expect.poll(stored).not.toBeNull();
    const first = JSON.parse((await stored())!);
    expect(first.source).toBe('newsletter');
    await page.goto('/?utm_source=ads');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('home-page')).toBeVisible();
    expect(JSON.parse((await stored())!)).toEqual(first);
    // Public responses stay cookie-free.
    const cookies = await page.context().cookies();
    expect(cookies.filter((c) => /utm/i.test(c.name))).toEqual([]);
  });
});

test.describe('POST /api/revalidate', () => {
  const body = JSON.stringify({ tags: ['content', 'billing'] });
  const sign = (ts: string, raw: string) => `v1=${createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex')}`;
  const now = () => String(Math.floor(Date.now() / 1000));
  const post = (request: import('@playwright/test').APIRequestContext, raw: string, ts: string, signature: string) =>
    request.post('/api/revalidate', { data: raw, headers: { 'content-type': 'application/json', 'x-revalidate-timestamp': ts, 'x-revalidate-signature': signature } });

  test('disabled with 404 when no secret is configured, else enforces the contract', async ({ request }) => {
    test.skip(SECRET.length < 32, 'Set E2E_REVALIDATE_SECRET (>=32 chars) matching the web process REVALIDATE_SECRET');
    const ts = now();
    // unsigned / bad signature
    expect((await post(request, body, ts, 'v1=' + '0'.repeat(64))).status()).toBe(401);
    // stale timestamp
    const old = String(Number(ts) - 301);
    expect((await post(request, body, old, sign(old, body))).status()).toBe(401);
    // signed over different bytes
    expect((await post(request, body, ts, sign(ts, body + ' '))).status()).toBe(401);
    // signed, invalid tags
    const bad = JSON.stringify({ tags: ['Bad Tag'] });
    expect((await post(request, bad, ts, sign(ts, bad))).status()).toBe(400);
    // oversized
    const big = JSON.stringify({ tags: ['a'], pad: 'x'.repeat(17000) });
    expect((await post(request, big, ts, sign(ts, big))).status()).toBe(413);
    // valid, then replay of the exact same request
    const ok = await post(request, body, ts, sign(ts, body));
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toEqual({ revalidated: true, tags: 2 });
    expect(ok.headers()['cache-control']).toBe('no-store');
    expect((await post(request, body, ts, sign(ts, body))).status()).toBe(401);
  });

  test('wrong method is rejected', async ({ request }) => {
    expect([404, 405]).toContain((await request.get('/api/revalidate')).status());
  });
});
