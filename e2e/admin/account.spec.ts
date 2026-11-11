/** Account UI contract checks with synthetic API responses and no outbound service traffic. */
import { test, expect, type Page, type Route } from '@playwright/test';

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL) throw new Error('Synthetic admin checks require a local baseURL');
  const origin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/')) return respond(route, null, 503, 'Unmocked synthetic request');
    return route.continue();
  });
});

const identity = { id: 'synthetic-admin', username: 'synthetic', name: '合成管理员', email: 'synthetic@example.test',
  permissions: [{ id: '*', name: '全权限', actions: ['*'] }], attributes: {} };
const respond = (route: Route, result: unknown, status = 200, message = 'success', headers: Record<string, string> = {}) => route.fulfill({
  status, contentType: 'application/json', headers, body: JSON.stringify({ status, message, result }),
});
/** Access tokens are JWTs that name the same account and session (sub + sid); `jti` tells them apart. */
const jwt = (jti: string) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'synthetic-admin', sid: 'synthetic-sid', jti })).toString('base64url')}.sig`;
const ACCESS = jwt('synthetic-access'), FRESH = jwt('fresh-access'), EXPIRED_LOGIN = jwt('expired-login-access');
const menu = [{ id: 'users', name: '用户管理', path: '/users', type: 'menu' }, { id: 'profile', name: '个人中心', path: '/profile', type: 'menu' }];
/** Form control by label text; required fields append a "*" marker and password inputs are not textboxes. */
const field = (page: Page, label: string) => page.getByLabel(new RegExp(`^${label}\\s*\\*?$`));
async function signIn(page: Page) {
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('synthetic');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('Synthetic123');
  await page.getByRole('button', { name: /^登\s*录$/ }).click();
}
async function addSession(page: Page) {
  await page.goto('/login');
  await page.context().addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: new URL(page.url()).origin, httpOnly: true, sameSite: 'Lax' }]);
  // The persisted summary holds no tokens; a reload restores the session through one cookie refresh.
  await page.evaluate(() => localStorage.setItem('zucker-admin-session', JSON.stringify({ version: 0, state: {
    isAuthenticated: true, user: { id: 'synthetic-admin', username: 'synthetic', name: '合成管理员' }, permissions: ['*'],
  } })));
}
async function storedAuth(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('zucker-admin-session') || '{}').state);
}
function commonResponse(route: Route) {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/authorize/refresh') return respond(route, { access_token: ACCESS });
  if (path === '/api/menu/tree') return respond(route, menu);
  if (path === '/api/authorize/me') return respond(route, identity);
  if (path === '/api/users/_query') return respond(route, { data: [], total: 0, pageIndex: 0, pageSize: 20, totalPages: 0 });
  return respond(route, null, 503, 'Unmocked synthetic request');
}

for (const permission of ['*', 'superadmin']) {
  test(`login retains bare ${permission} and enables the permission-gated user action`, async ({ page }) => {
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/login')) return respond(route, { userId: identity.id, token: ACCESS }, 200, 'success',
        { 'set-cookie': 'zucker-session=synthetic-refresh; Path=/; HttpOnly; SameSite=Lax' });
      if (path.endsWith('/me')) return respond(route, { ...identity, permissions: [{ id: permission, name: '全权限', actions: ['*'] }] });
      return commonResponse(route);
    });
    await page.goto('/login?redirect=%2Fusers'); await signIn(page);
    await expect(page.getByRole('button', { name: '新建用户' })).toBeVisible();
    const state = await storedAuth(page);
    expect(state.permissions).toContain(permission); expect(state.permissions).not.toContain(`${permission}:*`);
    expect(state.token).toBeUndefined(); expect(state.refreshToken).toBeUndefined();
    expect((await page.context().cookies()).find(cookie => cookie.name === 'zucker-session')?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain('synthetic-refresh');
  });
}

test('a rejected login shows a retryable message without refreshing another session', async ({ page }) => {
  let refreshes = 0, attempts = 0;
  await page.route('**/api/authorize/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/refresh')) refreshes++;
    if (new URL(route.request().url()).pathname.endsWith('/login')) attempts++;
    return respond(route, null, 401, 'Invalid credentials');
  });
  await page.goto('/login'); await signIn(page);
  await expect(page.getByText('登录失败，请检查账号密码或稍后重试')).toBeVisible();
  // A failed attempt clears the password field; the retry needs it again.
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('Synthetic123');
  await page.getByRole('button', { name: /登\s*录$/ }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page).toHaveURL(/\/login$/); expect(refreshes).toBe(0);
});

test('login whose initial identity read expires fails without a cookie refresh and stays signed out', async ({ page }) => {
  // The sign-in adopts its own access token through the public client: there is no session to refresh yet,
  // so an expired token must not trigger the (cookie) refresh exchange and must not sign anyone in.
  let refreshes = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/login')) return respond(route, { userId: identity.id, token: EXPIRED_LOGIN });
    if (path.endsWith('/refresh')) { refreshes++; return respond(route, { access_token: FRESH }); }
    if (path.endsWith('/me')) return respond(route, null, 401, 'Expired access');
    return commonResponse(route);
  });
  await page.goto('/login?redirect=%2Fprofile'); await signIn(page);
  await expect(page.getByText('登录失败，请检查账号密码或稍后重试')).toBeVisible();
  await expect(page).toHaveURL(/\/login/); expect(refreshes).toBe(0);
  expect((await storedAuth(page))?.isAuthenticated ?? false).toBe(false);
});

test('profile posts only the editable name and leaves the email read-only', async ({ page }) => {
  const writes: unknown[] = [];
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/profile')) { writes.push(route.request().postDataJSON()); return respond(route, { success: true }); }
    return commonResponse(route);
  });
  await addSession(page); await page.goto('/profile');
  await expect(field(page, '邮箱')).toBeDisabled();
  await field(page, '姓名').fill('更新后的合成管理员');
  await page.getByRole('tabpanel', { name: '基本信息' }).getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('信息更新成功')).toBeVisible();
  expect(writes).toEqual([{ name: '更新后的合成管理员' }]);
  await expect(page.getByRole('banner').getByRole('button', { name: '账户菜单' })).toContainText('更新后的合成管理员');
});

test('wrong current password stays signed in, reports failure and does not refresh the session', async ({ page }) => {
  let refreshes = 0; const writes: unknown[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/refresh')) { refreshes++; return respond(route, { access_token: FRESH }); }
    if (path.endsWith('/password')) { writes.push(route.request().postDataJSON()); return respond(route, null, 401, 'Invalid current password'); }
    return commonResponse(route);
  });
  await addSession(page); await page.goto('/profile'); await expect(field(page, '姓名')).toHaveValue('合成管理员');
  refreshes = 0; // the page-load session restore used one cookie refresh
  await page.getByRole('tab', { name: '修改密码' }).click();
  await field(page, '当前密码').fill('Incorrect123');
  await field(page, '新密码').fill('Synthetic456');
  await field(page, '确认新密码').fill('Synthetic456');
  await page.getByRole('tabpanel', { name: '修改密码' }).getByRole('button', { name: '修改密码' }).click();
  await expect(page.getByText('密码修改失败，请检查当前密码并重试')).toBeVisible();
  expect(writes).toEqual([{ currentPassword: 'Incorrect123', password: 'Synthetic456' }]);
  await field(page, '当前密码').fill('StillWrong123');
  await page.getByRole('tabpanel', { name: '修改密码' }).getByRole('button', { name: '修改密码' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ currentPassword: 'StillWrong123', password: 'Synthetic456' });
  expect(refreshes).toBe(0); expect((await storedAuth(page)).isAuthenticated).toBe(true);
  await expect(page).toHaveURL(/\/profile$/);
});

test('password change refreshes an expired access token through a read and clears auth only after success', async ({ page }) => {
  let expired = false, refreshes = 0; const writes: Array<{ body: unknown; authorization: string }> = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/me') && expired && route.request().headers().authorization !== `Bearer ${FRESH}`) return respond(route, null, 401, 'Expired access');
    if (path.endsWith('/refresh')) { refreshes++; return respond(route, { access_token: expired ? FRESH : ACCESS }); }
    if (path.endsWith('/password')) {
      expect(new URL(route.request().url()).search).toBe('');
      writes.push({ body: route.request().postDataJSON(), authorization: route.request().headers().authorization });
      return respond(route, { success: true }, 200, 'success', { 'set-cookie': 'zucker-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
    }
    return commonResponse(route);
  });
  await addSession(page); await page.goto('/profile'); await expect(field(page, '姓名')).toHaveValue('合成管理员');
  expired = true; refreshes = 0; // the page-load session restore used one cookie refresh
  await page.getByRole('tab', { name: '修改密码' }).click();
  await field(page, '当前密码').fill('Synthetic123');
  await field(page, '新密码').fill('Synthetic456');
  await field(page, '确认新密码').fill('Synthetic456');
  await page.getByRole('tabpanel', { name: '修改密码' }).getByRole('button', { name: '修改密码' }).click();
  await expect(page).toHaveURL(/\/login(\?|$)/); expect(refreshes).toBe(1);
  expect(writes).toEqual([{ body: { currentPassword: 'Synthetic123', password: 'Synthetic456' }, authorization: `Bearer ${FRESH}` }]);
  expect((await storedAuth(page)).isAuthenticated).toBe(false);
  expect((await page.context().cookies()).some(cookie => cookie.name === 'zucker-session')).toBe(false);
});

test('logout reports failure and a successful retry revokes the cookie before clearing local auth', async ({ page }) => {
  let failLogout = true, logoutCalls = 0;
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/logout')) {
      logoutCalls++;
      return failLogout ? respond(route, null, 503, 'Unavailable') : respond(route, { success: true }, 200, 'success',
        { 'set-cookie': 'zucker-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
    }
    return commonResponse(route);
  });
  await addSession(page); await page.goto('/profile'); await expect(field(page, '姓名')).toHaveValue('合成管理员');
  await page.getByRole('button', { name: '账户菜单' }).click(); await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page.getByText('退出未完成，请重试')).toBeVisible();
  expect((await storedAuth(page)).isAuthenticated).toBe(true); await expect(page).toHaveURL(/\/profile$/);
  failLogout = false;
  await page.getByRole('button', { name: '账户菜单' }).click(); await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page).toHaveURL(/\/login(\?|$)/); expect(logoutCalls).toBe(2);
  expect((await storedAuth(page)).isAuthenticated).toBe(false);
  expect((await page.context().cookies()).some(cookie => cookie.name === 'zucker-session')).toBe(false);
});
