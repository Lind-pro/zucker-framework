/**
 * Shared harness for browser specs that drive the real templates/admin (fe-admin) UI against an
 * in-process API. Every non-origin request is aborted, so specs never reach external networks.
 */
import { chromium, expect as browserExpect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Screenshot/failure output directory (override with ADMIN_BROWSER_ARTIFACTS). */
export const artifactDir = process.env.ADMIN_BROWSER_ARTIFACTS || join(tmpdir(), 'zucker-admin-browser');
export function artifact(name: string): string {
  mkdirSync(artifactDir, { recursive: true });
  return join(artifactDir, name);
}

export interface AdminServer {
  origin: string;
  stop(): Promise<void>;
}

/** Start the templates/admin Vite dev server on a fixed port, proxying `/api` to the test API. */
export async function startAdmin(port: number, apiPort: number): Promise<AdminServer> {
  const origin = `http://localhost:${port}`;
  const vite: ChildProcess = spawn(
    resolve('../admin/node_modules/.bin/vite'),
    ['--host', 'localhost', '--port', String(port), '--strictPort'],
    {
      cwd: resolve('../admin'),
      env: { ...process.env, NODE_ENV: 'development', API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // If a hook times out before this resolves, the spec never receives `stop`; make sure the
  // child still dies with the test worker instead of holding its fixed port for the next run.
  const killOnExit = () => {
    if (vite.exitCode === null && vite.signalCode === null) vite.kill('SIGTERM');
  };
  process.once('exit', killOnExit);
  vite.once('exit', () => process.off('exit', killOnExit));
  let output = '';
  for (const stream of [vite.stdout, vite.stderr])
    stream?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-2000);
    });
  const stop = async () => {
    if (vite.exitCode !== null || vite.signalCode !== null) return;
    vite.kill('SIGTERM');
    await Promise.race([
      new Promise((done) => vite.once('exit', done)),
      new Promise((done) => setTimeout(done, 2500)),
    ]);
  };
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Admin startup failed: ${output}`);
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(1500) })).ok) return { origin, stop };
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  await stop();
  throw new Error(`Admin startup exceeded 45 seconds: ${output}`);
}

/** Playwright's bundled Chromium unless PLAYWRIGHT_CHANNEL selects an installed browser. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true });
}

/** A context that can only reach the admin origin. */
export async function isolatedContext(
  browser: Browser,
  origin: string,
  viewport = { width: 1440, height: 1000 },
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: origin, viewport });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'),
  );
  return context;
}

export async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.setDefaultNavigationTimeout(15000);
  return page;
}

/** Sign in through the fe-admin login form (zh-CN copy) and wait to leave the login route. */
export async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await labeled(page, '用户名').fill(username);
  await labeled(page, '密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await browserExpect(page).not.toHaveURL(/\/login(?:\?|$)/);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Control by its exact visible label. Required fields append an aria-hidden "*" to the <label>,
 * which Playwright's exact label matching would otherwise include.
 */
export function labeled(scope: Page | Locator, label: string): Locator {
  return scope.getByLabel(new RegExp(`^${escapeRegExp(label)}\\*?$`));
}

/**
 * fe-admin renders every data table twice (table for md+, stacked cards below md); only one is
 * visible. These return the visible record for a text match at the current viewport.
 */
export function record(page: Page | Locator, text: string | RegExp): Locator {
  return page
    .locator('table[aria-label] > tbody > tr, ul[aria-label] > li')
    .filter({ hasText: text })
    .filter({ visible: true });
}

export const visible = (locator: Locator) => locator.filter({ visible: true });

/** Value shown for a label in a KeyValueList (`<dt>` label / `<dd>` value). */
export function definition(scope: Locator, label: string): Locator {
  return scope.locator('dt', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }).locator('xpath=following-sibling::dd[1]');
}

export const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
