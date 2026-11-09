import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expect as browserExpect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connectionBrowserFixture } from './helpers/connection-browser-fixture';
import { artifact, isolatedContext, launchBrowser, login, newPage, startAdmin, type AdminServer } from './helpers/fe-admin-browser';

const run = process.env.TEST_DATABASE_URL && process.env.RUN_SESSION_BROWSER === '1' ? describe : describe.skip;
const port = 4332;

interface HeldRefresh {
  /** Resolves once the API has answered (the refresh token is already rotated server-side). */
  answered: Promise<void>;
  /** Whether the browser was still waiting when the response was released, and when. */
  outcome: Promise<{ result: 'delivered' | 'dropped'; at: number }>;
}

/**
 * HTTP proxy between the admin dev server and the API. It can hold the next refresh response
 * after the API rotated the token, so a navigation can interrupt the exchange in the window where
 * the server has rotated but the browser has not yet received the new HttpOnly cookie.
 */
async function startHoldingProxy(apiPort: number) {
  type Outcome = { result: 'delivered' | 'dropped'; at: number };
  const pending: Array<{ holdMs: number; answered: () => void; outcome: (value: Outcome) => void }> = [];
  const counts = { refresh: 0, me: 0, statuses: [] as number[] };
  const server: Server = createServer((req, res) => {
    const isRefresh = req.method === 'POST' && req.url === '/api/authorize/refresh';
    if (isRefresh) counts.refresh++;
    if (req.method === 'GET' && req.url === '/api/authorize/me') counts.me++;
    const hold = isRefresh ? pending.shift() : undefined;
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) clientGone = true;
    });
    const upstream = httpRequest(
      { host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers: req.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          if (isRefresh) counts.statuses.push(response.statusCode ?? 0);
          hold?.answered();
          const release = () => {
            if (clientGone || res.destroyed) {
              hold?.outcome({ result: 'dropped', at: Date.now() });
              return;
            }
            res.writeHead(response.statusCode ?? 502, response.headers);
            res.end(Buffer.concat(chunks));
            hold?.outcome({ result: 'delivered', at: Date.now() });
          };
          if (hold) setTimeout(release, hold.holdMs);
          else release();
        });
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: (server.address() as AddressInfo).port,
    counts,
    /** Hold the next refresh response for `holdMs` after the API answered it. */
    holdNextRefresh(holdMs: number): HeldRefresh {
      let answered!: () => void, outcome!: (value: Outcome) => void;
      const held: HeldRefresh = {
        answered: new Promise<void>((done) => (answered = done)),
        outcome: new Promise((done) => (outcome = done)),
      };
      pending.push({ holdMs, answered, outcome });
      return held;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

run('fe-admin session restore against the real account module', () => {
  let f: Awaited<ReturnType<typeof connectionBrowserFixture>>,
    proxy: Awaited<ReturnType<typeof startHoldingProxy>>,
    admin: AdminServer,
    browser: Browser,
    context: BrowserContext,
    page: Page;
  const pageErrors: string[] = [];
  const signedIn = async (path: string, heading: string) => {
    await browserExpect(page).toHaveURL(new RegExp(`${path}$`));
    await browserExpect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  };
  beforeAll(async () => {
    f = await connectionBrowserFixture(process.env.TEST_DATABASE_URL!, `http://localhost:${port}`);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    proxy = await startHoldingProxy(address.port);
    admin = await startAdmin(port, proxy.port);
    browser = await launchBrowser();
    context = await isolatedContext(browser, admin.origin);
    page = await newPage(context);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // First visit to a fresh Vite server may optimize dependencies and reload.
    await page.goto('/login');
    await page.locator('input[name="username"]').waitFor({ state: 'visible', timeout: 45_000 });
    await page.waitForLoadState('networkidle');
    await login(page, 'connectionadmin', f.password);
    await signedIn('/dashboard', '概览');
  }, 65_000);
  afterEach(async (test) => {
    if (test.task.result?.state === 'fail' && page) {
      await page.screenshot({ path: artifact('session-restore-failure.png'), fullPage: true, animations: 'disabled' });
      console.info('Session restore failure view:', page.url());
    }
  });
  afterAll(async () => {
    await browser?.close();
    await admin?.stop();
    await proxy?.close();
    await f?.close();
  });

  it('keeps the session when a full navigation interrupts the restore exchange after the server rotated the token', async () => {
    const held = proxy.holdNextRefresh(1500);
    const statuses = proxy.counts.statuses.length;
    await page.reload({ waitUntil: 'commit' });
    await held.answered;
    // The server has rotated the refresh token; leave the document before the response arrives.
    await page.goto('/users', { waitUntil: 'commit' });
    const committed = Date.now();
    // Before the fix the browser cancelled the exchange here (`dropped`) and the stale cookie
    // signed the user out. The keepalive exchange outlives the document and stores the cookie.
    const outcome = await held.outcome;
    expect(outcome.at).toBeGreaterThan(committed);
    expect(outcome.result).toBe('delivered');
    await signedIn('/users', '用户');
    // The new page was denied while the old exchange was still completing, then retried.
    const seen = proxy.counts.statuses.slice(statuses);
    expect(seen).toContain(401);
    expect(seen.at(-1)).toBe(200);
    await page.reload();
    await signedIn('/users', '用户');
  });

  it('keeps the session when the user changes route inside the app while the restore exchange is pending', async () => {
    const held = proxy.holdNextRefresh(1200);
    await page.reload({ waitUntil: 'commit' });
    await held.answered;
    await page.evaluate(() => {
      window.history.pushState({}, '', '/roles');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect((await held.outcome).result).toBe('delivered');
    await signedIn('/roles', '角色');
    await page.reload();
    await signedIn('/roles', '角色');
  });

  it('restores once per reload and stays signed in across 15 reloads within a minute', async () => {
    await page.goto('/dashboard');
    await signedIn('/dashboard', '概览');
    const before = { ...proxy.counts, statuses: proxy.counts.statuses.length };
    const started = Date.now();
    for (let index = 0; index < 15; index++) {
      await page.reload();
      await signedIn('/dashboard', '概览');
    }
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(proxy.counts.refresh - before.refresh).toBe(15);
    expect(proxy.counts.statuses.slice(before.statuses).every((status) => status === 200)).toBe(true);
    expect(pageErrors).toEqual([]);
  }, 90_000);
});
