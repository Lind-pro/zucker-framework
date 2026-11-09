import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockServer, meResponse, renderAdmin, testToken, type MockRequest } from './test/harness';

const menuTree = [
  { id: 'starter:dashboard', name: '概览', path: '/dashboard', sortOrder: 0, status: true, permissions: [] },
  {
    id: 'starter:identity',
    name: '用户与权限',
    sortOrder: 1,
    status: true,
    permissions: [],
    children: [
      { id: 'starter:users', name: '用户', path: '/users', sortOrder: 0, status: true, permissions: ['users:query'] },
      { id: 'starter:roles', name: '角色', path: '/roles', sortOrder: 1, status: true, permissions: ['roles:query'] },
      { id: 'custom:unknown', name: '未注册页面', path: '/not-registered', sortOrder: 2, status: true, permissions: [] },
      { id: 'custom:off', name: '停用菜单', path: '/permissions', sortOrder: 3, status: false, permissions: [] },
    ],
  },
];

function baseRoutes() {
  return {
    'GET /menu/tree': menuTree,
    'POST /users/_count': { total: 3 },
    'POST /users/_query': { data: [{ id: 'u1', username: 'alice', email: 'alice@example.test', status: true }], total: 1 },
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('admin shell', () => {
  it('signs in through the account module and lands on the requested page', async () => {
    const token = testToken({ sub: 'admin-1', sid: 'session-1' });
    const server = createMockServer({
      ...baseRoutes(),
      'POST /authorize/login': ({ body }: MockRequest) =>
        (body as { username: string }).username === 'admin' ? { data: { userId: 'admin-1', token } } : { status: 401, data: { message: 'bad' } },
      'GET /authorize/me': ({ headers }: MockRequest) =>
        headers.authorization === `Bearer ${token}` ? { data: meResponse(['dashboard:query', 'users:query']) } : { status: 401 },
    });
    const app = renderAdmin({ httpAdapter: server.adapter as never }, { path: '/users?tab=1' });

    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeTruthy();
    expect(app.router.state.location.pathname).toBe('/login');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('请填写用户名')).toBeTruthy();
    expect(server.find('POST', '/authorize/login')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('table', { name: '用户' })).toBeTruthy();
    expect(app.router.state.location.pathname).toBe('/users');
    expect(app.router.state.location.search).toBe('?tab=1');
    const state = app.session.store.getState();
    expect(state.token).toBe(token);
    expect(state.permissions).toEqual(['dashboard:query', 'users:query']);
    // Neither token is persisted; only the session summary is.
    expect(localStorage.getItem('zucker-admin-session')).not.toContain(token);
    // Subsequent requests carry the access token.
    expect(server.find('POST', '/users/_query')[0]!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('keeps the login form with an error when sign-in fails', async () => {
    const server = createMockServer({ 'POST /authorize/login': { status: 401, data: { message: 'invalid' } } });
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/login' });
    fireEvent.change(await screen.findByLabelText(/用户名/), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('登录失败，请检查账号密码或稍后重试')).toBeTruthy();
  });

  it('filters the backend menu by registered routes and permissions', async () => {
    const server = createMockServer(baseRoutes());
    renderAdmin({ httpAdapter: server.adapter as never }, { permissions: ['dashboard:query', 'users:query'] });
    const nav = (await screen.findAllByRole('navigation', { name: '管理功能' }))[0]!;
    await waitFor(() => expect(within(nav).getByRole('link', { name: '用户' })).toBeTruthy());
    expect(within(nav).queryByRole('link', { name: '角色' })).toBeNull();
    expect(within(nav).queryByText('未注册页面')).toBeNull();
    expect(within(nav).queryByText('停用菜单')).toBeNull();
    expect(within(nav).getByText('用户与权限')).toBeTruthy();
  });

  it('localizes unchanged starter menu names only', async () => {
    const server = createMockServer({
      ...baseRoutes(),
      'GET /menu/tree': [
        { id: 'starter:users', name: '用户', path: '/users', sortOrder: 0, status: true, permissions: [] },
        { id: 'starter:roles', name: '客户角色', path: '/roles', sortOrder: 1, status: true, permissions: [] },
      ],
      'POST /roles/_count': { total: 1 },
      'POST /permissions/_count': { total: 1 },
    });
    renderAdmin(
      { httpAdapter: server.adapter as never, locale: 'en-US', locales: { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } } },
      { permissions: ['*'] },
    );
    const nav = (await screen.findAllByRole('navigation', { name: 'Administration features' }))[0]!;
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Users' })).toBeTruthy());
    expect(within(nav).getByRole('link', { name: '客户角色' })).toBeTruthy();
  });

  it('shows 403 for a direct URL without permission and makes no page request', async () => {
    const server = createMockServer({ ...baseRoutes(), 'POST /roles/_query': { data: [], total: 0 } });
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/roles', permissions: ['users:query'] });
    expect(await screen.findByRole('heading', { name: '没有访问权限' })).toBeTruthy();
    expect(server.find('POST', '/roles/_query')).toHaveLength(0);
  });

  it('shows not found for unregistered paths and honours disabled pages', async () => {
    const server = createMockServer(baseRoutes());
    renderAdmin({ httpAdapter: server.adapter as never, pages: { users: false } }, { path: '/users', permissions: ['*'] });
    expect(await screen.findByRole('heading', { name: '页面不存在' })).toBeTruthy();
  });

  it('renders product pages inside the shell with their own permission', async () => {
    const server = createMockServer(baseRoutes());
    renderAdmin(
      {
        httpAdapter: server.adapter as never,
        extraPages: [{ key: 'reports', path: '/reports', title: 'Reports', permission: 'reports:query', component: () => <p>product report</p> }],
      },
      { path: '/reports', permissions: ['reports:query'] },
    );
    expect(await screen.findByText('product report')).toBeTruthy();
  });

  it('marks only the longest matching menu path as current, also for sibling prefixes', async () => {
    const server = createMockServer({
      ...baseRoutes(),
      'GET /menu/tree': [
        {
          id: 'custom:site', name: '站点', sortOrder: 0, status: true, permissions: [],
          children: [
            { id: 'custom:reports', name: 'Reports', path: '/reports', sortOrder: 0, status: true, permissions: [] },
            { id: 'custom:report-types', name: 'Report types', path: '/reports/types', sortOrder: 1, status: true, permissions: [] },
          ],
        },
      ],
    });
    renderAdmin(
      {
        httpAdapter: server.adapter as never,
        extraPages: [
          { key: 'reports', path: '/reports', title: 'Reports', component: () => <p>product report</p> },
          { key: 'report-types', path: '/reports/types', title: 'Report types', component: () => <p>report types</p> },
        ],
      },
      { path: '/reports/types', permissions: ['*'] },
    );
    expect(await screen.findByText('report types')).toBeTruthy();
    const nav = (await screen.findAllByRole('navigation', { name: '管理功能' }))[0]!;
    const types = await within(nav).findByRole('link', { name: 'Report types' });
    expect(types.getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Reports' }).getAttribute('aria-current')).toBeNull();
    // The breadcrumb follows the same (deepest) item.
    const breadcrumb = screen.getByRole('navigation', { name: '面包屑' });
    expect(within(breadcrumb).getByText('Report types').getAttribute('aria-current')).toBe('page');
    expect(within(breadcrumb).queryByText('Reports')).toBeNull();
  });

  it('signs out through the account menu', async () => {
    const server = createMockServer({ ...baseRoutes(), 'POST /authorize/logout': { success: true } });
    const app = renderAdmin({ httpAdapter: server.adapter as never }, { permissions: ['dashboard:query'] });
    const trigger = await screen.findByRole('button', { name: '账户菜单' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '退出登录' }));
    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeTruthy();
    expect(server.find('POST', '/authorize/logout')).toHaveLength(1);
    expect(app.session.store.getState().isAuthenticated).toBe(false);
  });

  it('keeps the session when the logout request fails for a reason other than expiry', async () => {
    const server = createMockServer({ ...baseRoutes(), 'POST /authorize/logout': { status: 500, data: { message: 'down' } } });
    const app = renderAdmin({ httpAdapter: server.adapter as never }, { permissions: ['dashboard:query'] });
    fireEvent.keyDown(await screen.findByRole('button', { name: '账户菜单' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '退出登录' }));
    await waitFor(() => expect(server.find('POST', '/authorize/logout')).toHaveLength(1));
    expect(app.session.store.getState().isAuthenticated).toBe(true);
    expect(app.router.state.location.pathname).toBe('/dashboard');
  });

  it('restores a persisted session through cookie refresh after reload', async () => {
    const token = testToken({ sub: 'admin-1', sid: 'session-1' });
    localStorage.setItem(
      'zucker-admin-session',
      JSON.stringify({ state: { isAuthenticated: true, user: { id: 'admin-1', username: 'admin' }, permissions: ['dashboard:query'] }, version: 0 }),
    );
    const refresh = vi.fn(async () => ({ access_token: token }));
    const server = createMockServer({ ...baseRoutes(), 'GET /authorize/me': meResponse(['dashboard:query', 'users:query']) });
    const app = renderAdmin({ httpAdapter: server.adapter as never, refresh }, { path: '/users' });
    expect(await screen.findByRole('table', { name: '用户' })).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
    expect(app.session.store.getState().permissions).toContain('users:query');
  });

  it('sends the user to login when the refresh cookie is gone', async () => {
    localStorage.setItem(
      'zucker-admin-session',
      JSON.stringify({ state: { isAuthenticated: true, user: { id: 'admin-1', username: 'admin' }, permissions: ['*'] }, version: 0 }),
    );
    const server = createMockServer(baseRoutes());
    const app = renderAdmin({ httpAdapter: server.adapter as never }, { path: '/users' });
    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeTruthy();
    expect(app.router.state.location.search).toContain('redirect=%2Fusers');
  });

  it('rejects a refreshed token that belongs to another session and signs out', async () => {
    const other = testToken({ sub: 'someone-else', sid: 'session-9' });
    let first = true;
    const server = createMockServer({
      ...baseRoutes(),
      'POST /users/_query': () => {
        if (first) {
          first = false;
          return { status: 401, data: { message: 'expired' } };
        }
        return { data: { data: [], total: 0 } };
      },
    });
    const app = renderAdmin(
      { httpAdapter: server.adapter as never, refresh: async () => ({ access_token: other }) },
      { path: '/users', permissions: ['users:query'] },
    );
    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeTruthy();
    expect(app.session.store.getState().token).toBeNull();
    expect(server.find('POST', '/users/_query').every((call) => call.headers.authorization !== `Bearer ${other}`)).toBe(true);
  });

  it('reports a failed menu load with retry instead of an empty menu', async () => {
    let fail = true;
    const server = createMockServer({
      ...baseRoutes(),
      'GET /menu/tree': () => (fail ? { status: 500, data: { message: 'down' } } : { data: menuTree }),
    });
    renderAdmin({ httpAdapter: server.adapter as never }, { permissions: ['dashboard:query', 'users:query'] });
    expect(await screen.findByText(/菜单加载失败/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!);
    const nav = (await screen.findAllByRole('navigation', { name: '管理功能' }))[0]!;
    await waitFor(() => expect(within(nav).getByRole('link', { name: '用户' })).toBeTruthy());
  });
});
