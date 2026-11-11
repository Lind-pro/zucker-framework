/** Shared synthetic API mocking for the account-security specs (no real backend, email or provider). */
import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';

export const challenge = 'c'.repeat(43);
export const ticket = 't'.repeat(43);
export const proof = 'p'.repeat(43);
export const identity = { id: 'synthetic-user', username: 'synthetic', name: 'Synthetic', email: 'synthetic@example.test', emailVerified: true, permissions: [] };

export interface ApiCall { method: string; path: string; body: any }
type Handler = (route: Route, path: string, body: any, method: string) => Promise<void> | void | undefined;

export const ok = (route: Route, result: unknown) => route.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ status: 200, message: 'success', result }),
  // Responses that open a session carry the refresh cookie, as the server does.
  headers: result && typeof result === 'object' && ('token' in result || 'access_token' in result)
    ? { 'Set-Cookie': 'zucker-session=synthetic; Path=/; HttpOnly; SameSite=Lax' } : {} });
export const fail = (route: Route, status: number, code: string, details?: unknown) => route.fulfill({ status, contentType: 'application/json',
  body: JSON.stringify({ status, code, message: code, result: { reason: code, ...(details ? { details } : {}) } }) });

/** Blocks every origin except the app's own and routes `/api/**` to the handler (unmocked paths answer 404 NOT_MOCKED). */
export async function installApi(context: BrowserContext, baseURL: string, handler: Handler): Promise<ApiCall[]> {
  const origin = new URL(baseURL).origin, calls: ApiCall[] = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort('blockedbyclient');
  });
  await context.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api/, '');
    let body: any; try { body = request.postDataJSON(); } catch { body = undefined; }
    calls.push({ method: request.method(), path, body });
    return handler(route, path, body, request.method()) ?? fail(route, 404, 'NOT_MOCKED');
  });
  return calls;
}
export const bodyOf = (calls: ApiCall[], path: string, index = 0) => calls.filter(call => call.path === path)[index]?.body;
export const count = (calls: ApiCall[], path: string) => calls.filter(call => call.path === path).length;

/** A browser session as the app keeps it: HttpOnly refresh cookie plus the persisted auth store. */
export async function signedIn(page: Page, context: BrowserContext, baseURL: string, locale = 'en') {
  await page.goto(`/${locale}/login`);
  await context.addCookies([{ name: 'zucker-session', value: 'synthetic', url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
  await page.evaluate(() => localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: { token: 'access', refreshToken: null, isAuthenticated: true,
    user: { id: 'synthetic-user', username: 'synthetic' }, permissions: [] } })));
}
export const storedToken = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state?.token ?? null);

export async function expectNoSecretsInUrl(page: Page, ...secrets: string[]) {
  for (const secret of secrets) expect(page.url()).not.toContain(secret);
}
