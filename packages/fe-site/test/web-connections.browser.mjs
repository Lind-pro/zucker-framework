import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';

const template = fileURLToPath(new URL('../../../templates/web', import.meta.url));
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const next = createRequire(join(template, 'package.json')).resolve('next/dist/bin/next');
const executablePath = process.env.CHROMIUM_EXECUTABLE ??
  (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function startSite(directory, overrides = {}) {
  const port = await freePort();
  // NextURL normalizes loopback to localhost; match the server hostname for internal locale rewrites.
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, [next, 'dev', '--webpack', '--hostname', 'localhost', '--port', String(port)], {
    cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      API_URL: 'http://127.0.0.1:9/api', SITE_ANALYTICS_ENABLED: 'false', SITE_CONNECTIONS_ENABLED: 'false',
      ADSENSE_ENABLED: 'false', AFFONSO_ENABLED: 'false', PROMOTEKIT_ENABLED: 'false', CRISP_ENABLED: 'false', TAWK_ENABLED: 'false',
      ...overrides },
  });
  let output = '';
  const log = chunk => { output = (output + String(chunk)).slice(-16000); };
  child.stdout.on('data', log); child.stderr.on('data', log);
  const stop = async () => {
    if (child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
    for (let attempts = 0; attempts < 30 && child.exitCode === null; attempts++) await pause(100);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  };
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Site exited early: ${output}`);
    try {
      const response = await fetch(`${base}/ads.txt`, { signal: AbortSignal.timeout(1500) });
      if ([200, 404].includes(response.status)) return { base, stop, output: () => output };
    } catch { /* Await the owned development process within the startup deadline. */ }
    await pause(200);
  }
  await stop(); throw new Error(`Site did not become ready in 45 seconds: ${output}`);
}

const scripts = [
  ['adsense', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'],
  ['affonso', 'https://cdn.affonso.io/js/pixel.min.js'],
  ['promotekit', 'https://cdn.promotekit.com/promotekit.js'],
  ['crisp', 'https://client.crisp.chat/l.js'],
  ['tawk', 'https://embed.tawk.to/synthetic-property/synthetic-widget'],
];
async function browserContext(browser, base) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const observed = [], unexpected = [], errors = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === base) {
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Synthetic unauthenticated session"}' });
      return route.continue();
    }
    const provider = scripts.find(([, prefix]) => route.request().url().startsWith(prefix))?.[0];
    if (!provider) { unexpected.push(route.request().url()); return route.abort(); }
    observed.push(provider);
    const referral = provider === 'affonso' || provider === 'promotekit'
      ? `window.${provider}_referral='synthetic_${provider}';document.cookie='${provider}_referral=synthetic_${provider}; Path=/; SameSite=Lax';` : '';
    return route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
      body: `window.__siteProbe=window.__siteProbe||{};window.__siteProbe[${JSON.stringify(provider)}]=(window.__siteProbe[${JSON.stringify(provider)}]||0)+1;${referral}` });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  return { context, page, observed, unexpected, errors };
}

test('real Web routes keep default-off connections, hosted scripts and account isolation consistent', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zucker-site-connections-'));
  let site, browser;
  try {
    for (const name of ['src', 'package.json', 'next.config.ts', 'postcss.config.mjs', 'tailwind.config.ts', 'tsconfig.json']) {
      await cp(join(template, name), join(directory, name), { recursive: true });
    }
    await symlink(join(template, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await mkdir(join(directory, 'public'));
    await cp(join(packageDirectory, 'dist/index.mjs'), join(directory, 'public/site-connection-api.mjs'));
    browser = await chromium.launch({ executablePath, headless: true });

    site = await startSite(directory);
    let fixture = await browserContext(browser, site.base);
    const response = await fixture.page.goto(`${site.base}/en`);
    assert.equal(response.status(), 200);
    await fixture.page.locator('h1').waitFor();
    assert.equal(await fixture.page.locator('script[id^="zucker-site-"]').count(), 0);
    assert.equal((await fetch(`${site.base}/ads.txt`)).status, 404);
    assert.deepEqual(fixture.observed, []); assert.deepEqual(fixture.unexpected, []); assert.deepEqual(fixture.errors, []);
    await fixture.context.close(); await site.stop(); site = undefined;

    site = await startSite(directory, { SITE_CONNECTIONS_ENABLED: 'true', ADSENSE_ENABLED: 'true',
      ADSENSE_PUBLISHER_ID: 'ca-pub-1234567890123456', AFFONSO_ENABLED: 'true', AFFONSO_PROGRAM_ID: 'synthetic-affonso',
      AFFONSO_COOKIE_DURATION_DAYS: '30', PROMOTEKIT_ENABLED: 'true', PROMOTEKIT_PROGRAM_ID: 'synthetic-promotekit',
      CRISP_ENABLED: 'true', CRISP_WEBSITE_ID: '12345678-1234-1234-1234-123456789abc',
      TAWK_ENABLED: 'true', TAWK_PROPERTY_ID: 'synthetic-property', TAWK_WIDGET_ID: 'synthetic-widget' });
    fixture = await browserContext(browser, site.base);
    await fixture.page.goto(`${site.base}/en`);
    await fixture.page.waitForFunction(() => Object.keys(window.__siteProbe ?? {}).length === 5);
    assert.deepEqual([...fixture.observed].sort(), scripts.map(([provider]) => provider).sort());
    assert.equal(await fixture.page.locator('head script[id^="zucker-site-"]').count(), 7);
    assert.equal(await fixture.page.locator('#zucker-site-affonso-script').getAttribute('data-cookie_duration'), '30');
    assert.equal(await fixture.page.evaluate(() => window.CRISP_WEBSITE_ID), '12345678-1234-1234-1234-123456789abc');
    assert.equal(await fixture.page.evaluate(() => typeof window.Tawk_API), 'object');
    await fixture.page.evaluate(() => { window.__documentMarker = 'public-document'; });
    await fixture.page.locator('nav a[href$="#features"]').click();
    assert.equal(await fixture.page.evaluate(() => window.__documentMarker), 'public-document');
    assert.equal(fixture.observed.length, 5);

    await fixture.page.locator('a[href="/en/login"]').first().click();
    await fixture.page.waitForURL('**/en/login');
    await fixture.page.locator('#login-username').waitFor();
    assert.equal(await fixture.page.evaluate(() => window.__documentMarker), undefined);
    assert.equal(await fixture.page.evaluate(() => window.__siteProbe), undefined);
    assert.equal(await fixture.page.locator('script[id^="zucker-site-"]').count(), 0);
    const metadata = await fixture.page.evaluate(async () => {
      const api = await import('/site-connection-api.mjs');
      const policy = { enabledProviders: ['affonso', 'promotekit'] };
      return { ...api.referralMetadata(api.readBrowserReferral('affonso', policy), policy),
        ...api.referralMetadata(api.readBrowserReferral('promotekit', policy), policy) };
    });
    assert.deepEqual(metadata, { affonso_referral: 'synthetic_affonso', promotekit_referral: 'synthetic_promotekit' });
    await fixture.page.setViewportSize({ width: 390, height: 844 });
    // The template's default locale is zh with as-needed prefixes: use its actual /register entry.
    await fixture.context.addCookies([{ name: 'NEXT_LOCALE', value: 'zh', domain: new URL(site.base).hostname, path: '/' }]);
    await fixture.page.goto(`${site.base}/register`);
    await fixture.page.locator('input[type="email"]').waitFor();
    assert.equal(await fixture.page.locator('script[id^="zucker-site-"]').count(), 0);
    assert.equal(fixture.observed.length, 5);
    const ads = await fetch(`${site.base}/ads.txt`);
    assert.equal(ads.status, 200); assert.match(ads.headers.get('content-type'), /^text\/plain/);
    assert.equal(await ads.text(), 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
    assert.deepEqual(fixture.unexpected, []); assert.deepEqual(fixture.errors, []);
    await fixture.context.close();
  } catch (error) {
    if (site) error.message += `\nOwned site output:\n${site.output()}`;
    throw error;
  } finally {
    if (site) await site.stop();
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
