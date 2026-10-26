import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';

test.skip(process.env.RUN_SITE_INTEGRATIONS_BROWSER !== '1', 'Requires the dedicated local public-settings HTTP fixture');
test.describe.configure({ mode: 'serial' });
let server: Server;
let mode: 'enabled' | 'disabled' | 'failure' | 'invalid' = 'enabled';
const configuration = {
  analytics: { enabled: true, google: { enabled: true, measurementId: 'G-SAVEDTEST1' }, clarity: { enabled: true, projectId: 'synthetic123' },
    plausible: { enabled: true, scriptUrl: 'https://plausible.example.invalid/js/synthetic.js' },
    openPanel: { enabled: true, clientId: 'synthetic-client' }, vercel: { enabled: true, scriptPath: '/_vercel/insights/script.js' } },
  connections: { enabled: true, adsense: { enabled: true, publisherId: 'ca-pub-1234567890123456' },
    affonso: { enabled: true, programId: 'synthetic-program', cookieDurationDays: 30 }, promoteKit: { enabled: true, programId: 'synthetic-program' },
    crisp: { enabled: true, websiteId: '11111111-1111-4111-8111-111111111111' }, tawk: { enabled: true, propertyId: 'synthetic-property', widgetId: 'synthetic-widget' } },
  revisions: { analytics: 2, connections: 3 },
};
test.beforeAll(async () => {
  const port = Number(process.env.SITE_INTEGRATIONS_FIXTURE_PORT ?? '4328');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local fixture port');
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/site/public/integrations') {
      if (mode === 'failure') { response.statusCode = 503; response.end(JSON.stringify({ message: 'Synthetic unavailable' })); return; }
      const result = mode === 'disabled' ? { analytics: { enabled: false }, connections: { enabled: false }, revisions: { analytics: 3, connections: 4 } }
        : mode === 'invalid' ? { ...configuration, privateEnvironment: 'PRIVATE-SERVER-SENTINEL' } : configuration;
      response.end(JSON.stringify({ status: 200, result })); return;
    }
    if (url.pathname === '/api/content/public/settings') {
      response.end(JSON.stringify({ name: 'Synthetic website', theme: 'default', appearance: 'dark', description: '',
        navigation: [], footerLinks: [], siteUrl: 'http://localhost:4202' })); return;
    }
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || new URL(baseURL).hostname !== 'localhost') throw new Error('Use the dedicated localhost Web server');
  mode = 'enabled'; const origin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname === '/_vercel/insights/script.js') {
      if (route.request().resourceType() === 'script') return route.fulfill({ contentType: 'application/javascript', body: '/* synthetic provider script, no network */' });
      return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/authorize/')) return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    return route.continue();
  });
});

test('loads saved public connections once and serves the matching ads declaration', async ({ page }) => {
  await page.goto('/en');
  await expect(page.locator('script#zucker-analytics-google-init')).toHaveCount(1);
  await expect(page.locator('script#zucker-analytics-clarity-init')).toHaveCount(1);
  await expect(page.locator('script#zucker-analytics-plausible-script')).toHaveCount(1);
  await expect(page.locator('script#zucker-analytics-openPanel-init')).toHaveCount(1);
  await expect(page.locator('script#zucker-analytics-vercel-script')).toHaveCount(1);
  for (const provider of ['adsense', 'affonso', 'promotekit', 'crisp', 'tawk'])
    await expect(page.locator(`script#zucker-site-${provider}-script`)).toHaveCount(1);
  expect(await page.locator('script#zucker-analytics-google-init').textContent()).toContain('G-SAVEDTEST1');
  expect(await page.content()).not.toContain('G-LOCALFALLBACK');
  const ads = await page.request.get('/ads.txt'); expect(ads.status()).toBe(200);
  expect(await ads.text()).toBe('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
  await page.getByRole('link', { name: 'Get Started', exact: true }).first().click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.locator('script[id^="zucker-site-"], script[id^="zucker-analytics-"]')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as Window & { __zucker_site_analytics_google?: boolean }).__zucker_site_analytics_google))).toBe(false);
});

test('a saved disable applies on a new document and removes the publisher declaration', async ({ page }) => {
  await page.goto('/en'); await expect(page.locator('script#zucker-site-adsense-script')).toHaveCount(1);
  mode = 'disabled'; await page.reload();
  await expect(page.locator('script[id^="zucker-site-"], script[id^="zucker-analytics-"]')).toHaveCount(0);
  expect((await page.request.get('/ads.txt')).status()).toBe(404);
});

for (const failure of ['failure', 'invalid'] as const) {
  test(`public settings ${failure} keeps scripts off and does not reuse old environment IDs`, async ({ page }) => {
    mode = failure; await page.goto('/en');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('script[id^="zucker-site-"], script[id^="zucker-analytics-"]')).toHaveCount(0);
    expect(await page.content()).not.toContain('PRIVATE-SERVER-SENTINEL');
    expect(await page.content()).not.toContain('G-LOCALFALLBACK');
    const ads = await page.request.get('/ads.txt'); expect(ads.status()).toBe(503);
    expect(await ads.text()).toBe('Temporarily unavailable\n');
  });
}
