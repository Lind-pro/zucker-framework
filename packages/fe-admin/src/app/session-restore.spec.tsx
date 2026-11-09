import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApp } from './create-admin-app';
import { createMockServer, meResponse, testToken } from '../test/harness';

const token = testToken({ sub: 'admin-1', sid: 'session-1' });
const routes = {
  'GET /menu/tree': [
    { id: 'starter:users', name: '用户', path: '/users', sortOrder: 0, status: true, permissions: [] },
    { id: 'starter:roles', name: '角色', path: '/roles', sortOrder: 1, status: true, permissions: [] },
  ],
  'POST /users/_count': { total: 1 },
  'POST /users/_query': { data: [], total: 0 },
  'POST /roles/_query': { data: [], total: 0 },
  'GET /authorize/me': meResponse(['*']),
};

function persistSummary(userId = 'admin-1') {
  localStorage.setItem(
    'zucker-admin-session',
    JSON.stringify({ state: { isAuthenticated: true, user: { id: userId, username: 'admin' }, permissions: ['*'] }, version: 0 }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** Render like templates/admin: StrictMode (effects mount twice in development) on a memory router. */
function mount(
  refresh: () => Promise<{ access_token: string }>,
  server = createMockServer(routes),
  path = '/users',
  extra: { refreshTimeoutMs?: number } = {},
) {
  // StrictMode runs the router initializer twice; React keeps the first instance.
  let router: ReturnType<typeof createMemoryRouter> | undefined;
  const app = createAdminApp(
    { httpAdapter: server.adapter as never, refresh, ...(extra.refreshTimeoutMs ? { session: { refreshTimeoutMs: extra.refreshTimeoutMs } } : {}) },
    {
      createRouter: (definitions) => {
        const created = createMemoryRouter(definitions, { initialEntries: [path] });
        router ??= created;
        return created as never;
      },
    },
  );
  render(
    <StrictMode>
      <app.App />
    </StrictMode>,
  );
  const current = () => {
    if (!router) throw new Error('Router not created');
    return router;
  };
  return { app, server, router: current };
}

beforeEach(() => {
  localStorage.clear();
  persistSummary();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('session restore', () => {
  it('runs a single refresh exchange per page load, also under StrictMode', async () => {
    const refresh = vi.fn(async () => ({ access_token: token }));
    const { app } = mount(refresh);
    expect(await screen.findByRole('heading', { level: 1, name: '用户' })).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(app.session.store.getState().token).toBe(token);
  });

  it('completes and applies the exchange when the user navigates inside the app while it is pending', async () => {
    const pending = deferred<{ access_token: string }>();
    const refresh = vi.fn(() => pending.promise);
    const { app, router } = mount(refresh);
    expect(await screen.findByText('正在恢复登录状态…')).toBeTruthy();
    await act(async () => {
      await router().navigate('/roles');
    });
    expect(router().state.location.pathname).toBe('/roles');
    await act(async () => pending.resolve({ access_token: token }));
    expect(await screen.findByRole('heading', { level: 1, name: '角色' })).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(app.session.store.getState().token).toBe(token);
    expect(router().state.location.pathname).toBe('/roles');
  });

  it('does not move the page into another account whose cookie it received', async () => {
    const other = testToken({ sub: 'someone-else', sid: 'session-9' });
    const server = createMockServer({ ...routes, 'GET /authorize/me': meResponse(['*'], 'someone-else') });
    const { app, router } = mount(async () => ({ access_token: other }), server);
    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeTruthy();
    expect(app.session.store.getState().token).toBeNull();
    await waitFor(() => expect(router().state.location.pathname).toBe('/login'));
  });

  it('lets a sign-in wait for a pending restore so the restore cannot replace it', async () => {
    localStorage.clear();
    persistSummary('admin-1');
    const pending = deferred<{ access_token: string }>();
    const login = testToken({ sub: 'admin-2', sid: 'session-2' });
    const server = createMockServer({
      ...routes,
      'POST /authorize/login': { status: 200, data: { userId: 'admin-2', token: login } },
      'GET /authorize/me': ({ headers }: { headers: Record<string, string> }) => ({
        data: meResponse(['*'], headers.authorization === `Bearer ${login}` ? 'admin-2' : 'admin-1'),
      }),
    });
    const { app } = mount(() => pending.promise, server);
    const signingIn = app.session.login('admin2', 'secret');
    await act(async () => pending.resolve({ access_token: token }));
    await act(async () => {
      await signingIn;
    });
    await waitFor(() => expect(app.session.store.getState().token).toBe(login));
    expect(app.session.store.getState().user?.id).toBe('admin-2');
  });

  it('reports a hanging refresh as a failed restore instead of spinning forever', async () => {
    const refresh = vi.fn(() => new Promise<{ access_token: string }>(() => undefined));
    const { app } = mount(refresh, createMockServer(routes), '/users', { refreshTimeoutMs: 50 });
    expect(await screen.findByText('暂时无法恢复登录状态', undefined, { timeout: 3000 })).toBeTruthy();
    // Unknown outcome: the persisted summary is kept so the user can retry.
    expect(app.session.store.getState().isAuthenticated).toBe(true);
  });

  it('leaves the failed-restore screen for the sign-in page with "Login again"', async () => {
    const refresh = vi.fn(() => new Promise<{ access_token: string }>(() => undefined));
    const { app, router } = mount(refresh, createMockServer(routes), '/users', { refreshTimeoutMs: 50 });
    expect(await screen.findByText('暂时无法恢复登录状态', undefined, { timeout: 3000 })).toBeTruthy();
    act(() => {
      screen.getByRole('button', { name: '重新登录' }).click();
    });
    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeTruthy();
    expect(screen.queryByText('暂时无法恢复登录状态')).toBeNull();
    expect(app.session.store.getState().isAuthenticated).toBe(false);
    await waitFor(() => expect(router().state.location.pathname).toBe('/login'));
    expect(new URLSearchParams(router().state.location.search).get('redirect')).toBe('/users');
  });
});

describe('cross-tab session and request scope', () => {
  const storageEvent = (newValue: string | null) =>
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'zucker-admin-session', newValue }));

  it('signs this tab out when another tab signs out', async () => {
    const { app, router } = mount(async () => ({ access_token: token }));
    expect(await screen.findByRole('heading', { level: 1, name: '用户' })).toBeTruthy();
    const signedOut = JSON.stringify({ state: { isAuthenticated: false, user: null, permissions: [] }, version: 0 });
    localStorage.setItem('zucker-admin-session', signedOut);
    act(() => {
      storageEvent(signedOut);
    });
    expect(app.session.store.getState().token).toBeNull();
    await waitFor(() => expect(router().state.location.pathname).toBe('/login'));
  });

  it('leaves another tab’s account summary intact when this tab is dropped', async () => {
    const { app } = mount(async () => ({ access_token: token }));
    expect(await screen.findByRole('heading', { level: 1, name: '用户' })).toBeTruthy();
    const other = JSON.stringify({ state: { isAuthenticated: true, user: { id: 'admin-2', username: 'b' }, permissions: ['*'] }, version: 0 });
    localStorage.setItem('zucker-admin-session', other);
    act(() => {
      storageEvent(other);
    });
    expect(app.session.store.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('zucker-admin-session')).toBe(other);
  });

  it('aborts requests of the signed-in session when it signs out', async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    const server = createMockServer({ ...routes, 'GET /slow': () => pending.promise });
    const { app } = mount(async () => ({ access_token: token }), server);
    expect(await screen.findByRole('heading', { level: 1, name: '用户' })).toBeTruthy();
    const request = app.session.api.get('/slow');
    act(() => app.session.store.getState().logout());
    pending.resolve({ status: 200, data: { ok: true } });
    await expect(request).rejects.toMatchObject({ name: expect.stringMatching(/Cancel|Abort/) });
  });
});

