import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';

/**
 * Shared synthetic API for the AI generator / chat specs. Every /api/** call is answered here
 * (no real server); any other origin is blocked so a page that tried to load a remote URL fails
 * the test. Handlers are looked up by "METHOD /path" (query ignored) and can be replaced per test.
 */
export type ApiRequest = { method: string; url: URL; headers: Record<string, string>; body: unknown };
export type ApiReply = { status?: number; result?: unknown; code?: string; abort?: boolean; raw?: { contentType: string; body: string } };
export type ApiHandler = (request: ApiRequest, route: Route) => ApiReply | Promise<ApiReply>;

export const catalog = (overrides: Partial<Record<'image' | 'video' | 'audio', unknown>> = {}) => ({
  image: [
    { providerId: 'ai-fake', model: 'img-a', label: 'Fake Image A', cost: 5, available: true },
    { providerId: 'ai-fake', model: 'img-b', label: 'Fake Image B', cost: 9, available: true },
  ],
  video: [{ providerId: 'ai-fake', model: 'vid-a', label: 'Fake Video', cost: 40, available: true }],
  audio: [{ providerId: 'ai-fake', model: 'mus-a', label: 'Fake Music', cost: 20, available: true }],
  chat: [{ providerId: 'ai-fake', model: 'chat-a', label: 'Fake Chat', available: true }],
  chatPricing: { per1kInputTokens: 1, per1kOutputTokens: 2, minimum: 1 },
  ...overrides,
});

export const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1', kind: 'image', providerId: 'ai-fake', model: 'img-a', status: 'QUEUED', stage: null, progress: null, cost: 5, charge: 'HELD',
  prompt: 'a synthetic prompt', error: null, outputs: [], canCancel: true,
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', completedAt: null, ...overrides,
});

export const chatSummary = (overrides: Record<string, unknown> = {}) => ({
  id: 'chat-1', title: 'Synthetic chat', providerId: 'ai-fake', model: 'chat-a', messageCount: 2, cost: 1,
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', ...overrides,
});

export const sse = (...events: Array<[string, unknown]>) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');

export async function installApi(page: Page, context: BrowserContext, baseURL: string | undefined, initial: Record<string, ApiHandler> = {}) {
  if (!baseURL) throw new Error('baseURL is required');
  const origin = new URL(baseURL).origin;
  const handlers = new Map<string, ApiHandler>(Object.entries(initial));
  const calls: ApiRequest[] = [];
  const foreign: string[] = [];
  const unhandled: string[] = [];
  const count = (key: string) => calls.filter((call) => `${call.method} ${call.url.pathname}` === key).length;
  const callsTo = (key: string) => calls.filter((call) => `${call.method} ${call.url.pathname}` === key);

  handlers.set('GET /api/authorize/me', handlers.get('GET /api/authorize/me') ?? (() => ({ result: { id: 'user-a', username: 'synthetic', permissions: [] } })));
  handlers.set('GET /api/credits/balance', handlers.get('GET /api/credits/balance') ?? (() => ({ result: { available: 100 } })));
  // Header inbox bell (signed-in shell) polls the unread count.
  handlers.set('GET /api/inbox/unread-count', handlers.get('GET /api/inbox/unread-count') ?? (() => ({ result: { unreadCount: 0 } })));
  handlers.set('GET /api/files', handlers.get('GET /api/files') ?? (() => ({ result: { data: [], total: 0, page: 1, pageSize: 20 } })));

  await context.addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: { token: 'synthetic-token', refreshToken: null, isAuthenticated: true,
      user: { id: 'user-a', username: 'synthetic' }, permissions: [] } }));
  }, { origin });

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      foreign.push(request.url());
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const text = request.postData();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    const entry: ApiRequest = { method: request.method(), url, headers: request.headers(), body };
    calls.push(entry);
    const handler = handlers.get(`${entry.method} ${url.pathname}`);
    if (!handler) {
      unhandled.push(`${entry.method} ${url.pathname}`);
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ status: 503, message: 'unhandled', result: null }) });
    }
    const reply = await handler(entry, route);
    if (reply.abort) return route.abort('failed');
    if (reply.raw) return route.fulfill({ status: reply.status ?? 200, contentType: reply.raw.contentType, body: reply.raw.body });
    const status = reply.status ?? 200;
    return route.fulfill({
      status,
      contentType: 'application/json',
      // TransformInterceptor: a successful body always says status 200 whatever the HTTP code (201/202).
      body: JSON.stringify({ status: status < 400 ? 200 : status, message: status < 400 ? 'success' : 'Synthetic failure', ...(reply.code ? { code: reply.code } : {}), result: reply.result ?? null }),
    });
  });

  return {
    handlers, calls, foreign, unhandled, count, callsTo,
    on(key: string, handler: ApiHandler) { handlers.set(key, handler); },
    async expectNoForeignRequests() { expect(foreign).toEqual([]); },
  };
}

/**
 * The pages are keyed by the signed-in account id, so the first render (before the persisted auth
 * summary hydrates) is replaced once; interact only after the header shows the account menu.
 */
export async function waitForHydratedAccount(page: Page) {
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
}
