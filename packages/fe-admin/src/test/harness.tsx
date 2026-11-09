/* Test-only helpers: a routing HTTP adapter and an app factory on a memory router. */
import { render } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { createAdminApp, type AdminApp } from '../app/create-admin-app';
import type { AdminAppConfig } from '../app/config';

// jsdom lacks these browser APIs used by Radix primitives.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => undefined;
}

export interface MockRequest {
  method: string;
  url: string;
  params: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string>;
}
export type MockReply = { status?: number; data?: unknown } | undefined;
export type MockHandler = (request: MockRequest) => MockReply | Promise<MockReply>;

/** A static value with a numeric `status` is a full reply; anything else is the response body. */
const isReply = (value: unknown): value is MockReply =>
  !!value && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'number';

/** Route `"METHOD /path"` (exact) to handlers; unmatched requests fail with 404 so tests notice. */
export function createMockServer(routes: Record<string, MockHandler | unknown>) {
  const calls: MockRequest[] = [];
  const handlers = new Map(Object.entries(routes));
  const adapter = vi.fn(async (config: Record<string, unknown>) => {
    const headers = Object.fromEntries(
      Object.entries(
        typeof (config.headers as { toJSON?: () => object })?.toJSON === 'function'
          ? (config.headers as { toJSON: () => object }).toJSON()
          : ((config.headers as object) ?? {}),
      ).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );
    const request: MockRequest = {
      method: String(config.method ?? 'get').toUpperCase(),
      url: String(config.url ?? ''),
      params: (config.params as Record<string, unknown>) ?? {},
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
      headers,
    };
    calls.push(request);
    const handler = handlers.get(`${request.method} ${request.url}`);
    const reply: MockReply =
      handler === undefined
        ? { status: 404, data: { message: `No mock for ${request.method} ${request.url}` } }
        : typeof handler === 'function'
          ? await (handler as MockHandler)(request)
          : isReply(handler)
            ? handler
            : { data: handler };
    const status = reply?.status ?? 200;
    const response = { data: reply?.data ?? null, status, statusText: String(status), headers: {}, config };
    if (status >= 400) {
      throw Object.assign(new Error(`Request failed with status ${status}`), {
        isAxiosError: true,
        config,
        request: {},
        response,
        toJSON: () => ({}),
      });
    }
    return response;
  });
  return {
    adapter,
    calls,
    set: (key: string, handler: MockHandler | unknown) => handlers.set(key, handler),
    find: (method: string, url: string) => calls.filter((call) => call.method === method && call.url === url),
  };
}

/** Unsigned JWT-shaped token carrying the claims used for session binding. */
export function testToken(claims: Record<string, unknown>): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

export function meResponse(permissions: string[], id = 'admin-1') {
  return {
    id,
    username: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
    permissions: permissions.map((code) => {
      if (code === '*' || code === 'superadmin') return { id: code, actions: ['*'] };
      const split = code.lastIndexOf(':');
      return { id: code.slice(0, split), actions: [code.slice(split + 1)] };
    }),
  };
}

export function renderAdmin(
  config: AdminAppConfig,
  options: { path?: string; permissions?: string[] } = {},
): AdminApp & { router: ReturnType<typeof createMemoryRouter> } {
  let router!: ReturnType<typeof createMemoryRouter>;
  const app = createAdminApp(
    { refresh: vi.fn(async () => Promise.reject(Object.assign(new Error('no cookie'), { status: 401 }))), ...config },
    {
      createRouter: (routes) => {
        router = createMemoryRouter(routes, { initialEntries: [options.path ?? '/dashboard'] });
        return router as never;
      },
    },
  );
  if (options.permissions) signIn(app, options.permissions);
  render(<app.App />);
  return { ...app, router };
}

/** Sign the app's session in directly (bypassing the login form). */
export function signIn(app: AdminApp, permissions: string[], id = 'admin-1') {
  app.session.store.getState().setAuthState({
    token: testToken({ sub: id, sid: 'session-1' }),
    user: { id, username: 'admin', name: 'Admin' },
    permissions,
  });
}
