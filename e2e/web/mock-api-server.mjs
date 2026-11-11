#!/usr/bin/env node
/**
 * Minimal API for the `web-chromium` Playwright project (started by playwright.config.ts on
 * E2E_MOCK_API_PORT). The browser-side API is mocked per spec with page.route; only the Web server's own
 * server-side reads arrive here. It answers the CMS home page and public site settings (the home route
 * renders CMS blocks) and 503s everything else, so specs that rely on a failing server-side read (for
 * example billing's browser fallback) keep that behaviour. Synthetic data only; binds 127.0.0.1.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? process.env.E2E_MOCK_API_PORT);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('usage: mock-api-server.mjs <port>');
const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') return json(response, 200, { status: 'ok' });
  if (url.pathname === '/api/content/public/entry' && url.searchParams.get('kind') === 'page' && url.searchParams.get('slug') === 'home') {
    const locale = url.searchParams.get('locale') ?? 'en';
    return json(response, 200, { status: 200, result: { id: `home-${locale}`, kind: 'page', locale, slug: 'home', title: 'Home', description: '', authorName: 'Synthetic',
      publishedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', categories: [], source: 'database',
      document: { version: 2, title: 'Home', description: 'Synthetic home', authorName: 'Synthetic', markdown: '', seo: { title: '', description: '', noIndex: false },
        blocks: [{ id: 'hero', type: 'hero', enabled: true, heading: 'Synthetic home', text: '', action: { label: 'Get Started', href: '/register' } }] } } });
  }
  return json(response, 503, { status: 503, result: null, message: 'unmocked' });
}).listen(port, '127.0.0.1');
