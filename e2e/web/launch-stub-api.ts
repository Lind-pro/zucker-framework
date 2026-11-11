/**
 * Tiny synthetic Server for the web template's server-side reads (`API_URL`). Next fetches the CMS
 * and billing catalogs from its own process, so Playwright's page.route cannot intercept them.
 * Start the web template against it:
 *   API_URL=http://127.0.0.1:4393/api SITE_URL=http://127.0.0.1:4391 REVALIDATE_SECRET=<32+ chars> \
 *     next start -p 4391
 * and point Playwright at it with E2E_WEB_URL (see launch-marketing.spec.ts).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface StubRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: unknown;
}

const block = (id: string, type: string, rest: Record<string, unknown>) => ({ id, type, enabled: true, ...rest });
const doc = (title: string, blocks: unknown[]) => ({
  version: 2, title, description: `${title} description`, authorName: 'Synthetic', markdown: '', blocks,
  seo: { title: '', description: '', noIndex: false },
});
const entryBase = (over: Record<string, unknown>) => ({
  id: 'e1', kind: 'page', locale: 'en', slug: 'home', title: 'Home', description: '', authorName: 'Synthetic',
  publishedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', categories: [], source: 'database', ...over,
});

export const homeDocument = (locale: string) => doc(locale === 'zh' ? '首页' : 'Synthetic Home', [
  block('b1', 'hero', {
    heading: locale === 'zh' ? '合成首页标题' : 'Synthetic hero heading', text: 'Hero text',
    action: { label: 'See pricing', href: '/pricing' }, secondaryAction: { label: 'Read changelog', href: '/changelog' },
  }),
  block('b2', 'pricing', { heading: 'Plans', text: 'Pick one', plans: ['pro'], showCreditPacks: false }),
  block('b3', 'blog-list', { heading: 'Latest posts', text: '', limit: 3 }),
  block('b4', 'changelog', { heading: 'Releases', text: '', limit: 3 }),
]);

const money = (amount: string, currency = 'USD') => ({ amount, currency });
export const catalog = (current: boolean, policy: { defaultProvider: string | null; allowProviderChoice: boolean }) => ({
  plans: [
    {
      id: 'plan-free', slug: 'free', name: 'Free', description: 'Starter', order: 1, features: { api: true }, quotas: { calls: 100 },
      featured: false, badge: null, highlights: ['Community support'], current: false,
      prices: [{ interval: 'month', ...money('0.00'), termDays: null, offerId: null, purchasable: false, providers: [], credits: 0, creditExpiry: null }],
    },
    {
      id: 'plan-pro', slug: 'pro', name: 'Pro', description: 'For teams', order: 2, features: { api: true }, quotas: { calls: -1 },
      featured: true, badge: null, highlights: [], current,
      prices: [
        { interval: 'month', ...money('19.90'), termDays: null, offerId: 'offer-pro-month', purchasable: true, providers: ['stripe', 'paypal'], credits: 500, creditExpiry: 'period' },
        { interval: 'year', ...money('199.00'), termDays: null, offerId: 'offer-pro-year', purchasable: true, providers: ['stripe', 'paypal'], credits: 6000, creditExpiry: 'period' },
      ],
    },
  ],
  packs: [{
    id: 'pack-1', slug: 'small', title: 'Small pack', description: null, credits: 1000, expiresInDays: 365, order: 1,
    prices: [{ ...money('9.00'), offerId: 'offer-pack-small', purchasable: true, providers: ['stripe', 'paypal'] }],
  }],
  checkout: policy,
});

export interface StubState {
  policy: { defaultProvider: string | null; allowProviderChoice: boolean };
  requests: StubRequest[];
}

export async function startStubApi(port: number): Promise<{ server: Server; state: StubState; close: () => Promise<void> }> {
  const state: StubState = { policy: { defaultProvider: 'paypal', allowProviderChoice: false }, requests: [] };
  const read = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch { resolve(null); }
      });
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const body = req.method === 'POST' ? await read(req) : null;
    const authorization = req.headers['authorization'];
    state.requests.push({
      method: req.method ?? 'GET', path: url.pathname + url.search,
      authorization: Array.isArray(authorization) ? authorization[0] : authorization,
      idempotencyKey: req.headers['idempotency-key'] as string | undefined, body,
    });
    const send = (status: number, result: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ status, message: status === 200 ? 'success' : 'error', result }));
    };
    const p = url.pathname;
    const q = url.searchParams;
    const locale = q.get('locale') ?? 'en';
    if (p === '/api/content/public/settings')
      return send(200, { name: 'Synthetic Site', description: 'Synthetic description', theme: 'default', appearance: 'light', navigation: [], footerLinks: [], siteUrl: 'http://127.0.0.1:4391' });
    if (p === '/api/content/public/entry') {
      const kind = q.get('kind'), slug = q.get('slug');
      if (kind === 'page' && slug === 'home') return send(200, { ...entryBase({ locale }), document: homeDocument(locale) });
      if (kind === 'log' && slug === 'v1-0')
        return send(200, { ...entryBase({ id: 'l1', kind: 'log', slug: 'v1-0', title: 'Release 1.0', locale }), document: doc('Release 1.0', [block('m', 'markdown', { heading: '', markdown: 'Notes for 1.0' })]) });
      return send(404, null);
    }
    if (p === '/api/content/public/entries') {
      const kind = q.get('kind') ?? 'post';
      const data = kind === 'post'
        ? [entryBase({ id: 'p1', kind: 'post', slug: 'first-post', title: 'First post', description: 'Post summary', locale })]
        : kind === 'log' ? [entryBase({ id: 'l1', kind: 'log', slug: 'v1-0', title: 'Release 1.0', description: 'Release summary', locale })] : [];
      return send(200, { data, total: data.length, page: 1, pageSize: 20, category: null });
    }
    if (p === '/api/content/public/categories') return send(200, []);
    if (p === '/api/content/public/sitemap') return send(200, []);
    if (p === '/api/billing/plans') {
      // Only an authenticated request may see `current`, exactly like the real Server.
      return send(200, catalog(authorization === 'Bearer synthetic-token', state.policy));
    }
    if (p === '/api/billing/entitlements/catalog')
      return send(200, { features: [{ key: 'api', label: 'API access', counter: 'calls' }], counters: [{ key: 'calls', label: 'Calls', unit: 'calls / month' }] });
    // Like the real Server: a guest's identity read is 401, and only the synthetic session cookie refreshes.
    if (p === '/api/authorize/me')
      return authorization === 'Bearer synthetic-token' ? send(200, { id: 'synthetic-user', username: 'synthetic', permissions: [] }) : send(401, null);
    if (p === '/api/authorize/refresh' && req.method === 'POST')
      return /(?:^|;\s*)zucker-session=synthetic-session(?:;|$)/.test(req.headers.cookie ?? '') ? send(200, { access_token: 'synthetic-token' }) : send(401, null);
    if (p === '/api/billing/orders' && req.method === 'POST')
      return send(200, { id: 'a'.repeat(64), offerId: (body as { offerId?: string } | null)?.offerId ?? '', providerId: (body as { providerId?: string } | null)?.providerId ?? '', title: 'Synthetic', mode: 'subscription', money: money('19.90'), state: 'pending', creationState: 'created', captureState: 'idle', checkoutUrl: 'https://payments.example.test/checkout', fulfilledAt: null, createdAt: '2026-10-24T01:00:00.000Z', subscriptionId: null });
    return send(404, null);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
