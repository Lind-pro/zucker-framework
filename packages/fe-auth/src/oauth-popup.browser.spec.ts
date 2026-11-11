// @vitest-environment node
// Real-Chromium check of the popup protocol (real window.open + BroadcastChannel across two pages).
// Opt-in: RUN_BROWSER_TESTS=1 vitest run packages/fe-auth/src/oauth-popup.browser.spec.ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import ts from 'typescript';

const run = process.env.RUN_BROWSER_TESTS === '1' ? describe : describe.skip;
const STATE = 'state-0123456789abcdef-real';

run('OAuth popup protocol in a real browser', { timeout: 30_000 }, () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    const compile = (file: string) =>
      ts.transpileModule(readFileSync(resolve(__dirname, file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      }).outputText.replace(/from '\.\/redirect'/g, "from './redirect.js'");
    const files: Record<string, string> = {
      '/oauth-popup.js': compile('oauth-popup.ts'),
      '/redirect.js': compile('redirect.ts'),
    };
    const page = (body: string) => `<!doctype html><meta charset=utf-8><body><script type=module>import * as Popup from '/oauth-popup.js'; window.Popup = Popup; ${body}</script>`;
    // Opener: button click opens the popup synchronously, outcome lands in window.__result.
    const opener = page(`document.body.innerHTML = '<button id=go>go</button>';
      document.getElementById('go').onclick = () => {
        Popup.openOAuthPopup({ url: new URLSearchParams(location.search).get('popup') || ('/popup' + location.search), state: new URLSearchParams(location.search).get('state'), timeoutMs: 4000 })
          .then(r => { window.__result = r; });
      };`);
    // Popup: claims, then acts per ?mode.
    const popup = page(`const q = new URLSearchParams(location.search);
      Popup.claimOAuthPopup(q.get('state')).then(claim => {
        window.__claim = claim ? 'claimed' : 'none';
        if (!claim) return;
        if (q.get('mode') === 'fail') claim.fail(q.get('code') || 'ACCESS_DENIED');
        else claim.complete(q.get('returnPath') || undefined);
      });`);
    server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      if (files[path]) {
        res.setHeader('content-type', 'text/javascript');
        res.end(files[path]);
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(path === '/popup' ? popup : path === '/silent' ? '<!doctype html><body>silent' : opener);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
    context = await browser.newContext();
  }, 60_000);


  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => server?.close(ok));
  });

  async function attempt(query: string) {
    const page = await context.newPage();
    await page.goto(`${origin}/?state=${STATE}${query}`);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#go')]);
    const result = await page.waitForFunction(() => (window as never as { __result?: unknown }).__result, null, { timeout: 8000 })
      .then((h) => h.jsonValue());
    return { page, popup, result };
  }

  it('completes, passes only a safe return path, and closes the popup', async () => {
    const { page, popup, result } = await attempt('&mode=ok&returnPath=%2Fconsole%3Ftab%3D1');
    expect(result).toEqual({ status: 'completed', returnPath: '/console?tab=1' });
    await expect.poll(() => popup.isClosed(), { timeout: 3000 }).toBe(true);
    await page.close();
  });

  it('drops an off-site return path in the real channel', async () => {
    const { page, result } = await attempt('&mode=ok&returnPath=%2F%2Fevil.example');
    expect(result).toEqual({ status: 'completed' });
    await page.close();
  });

  it('reports a failure code and sanitises junk codes', async () => {
    const a = await attempt('&mode=fail&code=ACCESS_DENIED');
    expect(a.result).toEqual({ status: 'failed', code: 'ACCESS_DENIED' });
    await a.page.close();
    const b = await attempt('&mode=fail&code=%3Cscript%3E');
    expect(b.result).toEqual({ status: 'failed', code: 'OAUTH_FAILED' });
    await b.page.close();
  });

  it('a foreign state never reaches the opener; closing a silent popup resolves closed', async () => {
    const page = await context.newPage();
    await page.goto(`${origin}/?state=${STATE}&popup=/silent`);
    const stranger = await context.newPage();
    await stranger.goto(`${origin}/popup?state=other-state-0123456789abcdef&mode=ok`);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#go')]);
    await popup.close();
    const result = await page.waitForFunction(() => (window as never as { __result?: unknown }).__result, null, { timeout: 8000 })
      .then((h) => h.jsonValue());
    expect(result).toEqual({ status: 'closed' });
    await stranger.close();
    await page.close();
  });

  it('times out and closes the popup when nothing claims the attempt', async () => {
    const page = await context.newPage();
    await page.goto(`${origin}/?state=${STATE}&popup=/silent`);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#go')]);
    const result = await page.waitForFunction(() => (window as never as { __result?: unknown }).__result, null, { timeout: 9000 })
      .then((h) => h.jsonValue());
    expect(result).toEqual({ status: 'timeout' });
    await expect.poll(() => popup.isClosed(), { timeout: 3000 }).toBe(true);
    await page.close();
  });
});
