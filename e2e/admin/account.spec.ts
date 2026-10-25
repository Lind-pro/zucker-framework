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
const menu = [{ id: 'users', name: '用户管理', path: '/users', type: 'menu' }, { id: 'profile', name: '个人中心', path: '/profile', type: 'menu' }];
async function signIn(page: Page) {
  await page.getByPlaceholder('用户名', { exact: true }).fill('synthetic');
  await page.getByPlaceholder('密码', { exact: true }).fill('Synthetic123');
  await page.getByRole('button', { name: /^登\s*录$/ }).click();
}
async function addSession(page: Page) {
  await page.goto('/login');
  await page.context().addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: new URL(page.url()).origin, httpOnly: true, sameSite: 'Lax' }]);
  await page.evaluate(() => localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: {
    token: 'synthetic-access', refreshToken: null, isAuthenticated: true, user: { id: 'synthetic-admin', username: 'synthetic', name: '合成管理员' }, permissions: ['*'],
  } })));
}
async function storedAuth(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('auth-storage') || '{}').state);
}
function commonResponse(route: Route) {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/menu/tree') return respond(route, menu);
  if (path === '/api/authorize/me') return respond(route, identity);
  if (path === '/api/users/_query') return respond(route, { data: [], total: 0, pageIndex: 0, pageSize: 20, totalPages: 0 });
  return respond(route, null, 503, 'Unmocked synthetic request');
}

for (const permission of ['*', 'superadmin']) {
  test(`login retains bare ${permission} and enables the permission-gated user action`, async ({ page }) => {
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/login')) return respond(route, { userId: identity.id, token: 'synthetic-access' }, 200, 'success',
        { 'set-cookie': 'zucker-session=synthetic-refresh; Path=/; HttpOnly; SameSite=Lax' });
      if (path.endsWith('/me')) return respond(route, { ...identity, permissions: [{ id: permission, name: '全权限', actions: ['*'] }] });
      return commonResponse(route);
    });
    await page.goto('/login?redirect=%2Fusers'); await signIn(page);
    await expect(page.getByRole('button', { name: '新建用户' })).toBeVisible();
    const state = await storedAuth(page);
    expect(state.permissions).toContain(permission); expect(state.permissions).not.toContain(`${permission}:*`);
    expect(state.refreshToken).toBeNull();
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
  await page.getByRole('button', { name: /登\s*录$/ }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page).toHaveURL(/\/login$/); expect(refreshes).toBe(0);
});

test('login keeps the refreshed access token when its initial identity read expires', async ({ page }) => {
  let refreshes = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/login')) return respond(route, { userId: identity.id, token: 'expired-login-access' });
    if (path.endsWith('/refresh')) { refreshes++; expect(route.request().postDataJSON()).toEqual({}); return respond(route, { access_token: 'fresh-access' }); }
    if (path.endsWith('/me') && route.request().headers().authorization !== 'Bearer fresh-access') return respond(route, null, 401, 'Expired access');
    return commonResponse(route);
  });
  await page.goto('/login?redirect=%2Fprofile'); await signIn(page);
  await expect(page.getByLabel('姓名', { exact: true })).toHaveValue('合成管理员');
  expect((await storedAuth(page)).token).toBe('fresh-access'); expect(refreshes).toBe(1);
});

test('profile posts only the editable name and leaves the email read-only', async ({ page }) => {
  const writes: unknown[] = [];
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/profile')) { writes.push(route.request().postDataJSON()); return respond(route, { success: true }); }
    return commonResponse(route);
  });
  await addSession(page); await page.goto('/profile');
  await expect(page.getByLabel('邮箱', { exact: true })).toBeDisabled();
  await page.getByLabel('姓名', { exact: true }).fill('更新后的合成管理员');
  await page.getByRole('tabpanel', { name: '基本信息' }).getByRole('button', { name: /^提\s*交$/ }).click();
  await expect(page.getByText('信息更新成功')).toBeVisible();
  expect(writes).toEqual([{ name: '更新后的合成管理员' }]);
  await expect(page.getByRole('heading', { name: '更新后的合成管理员' })).toBeVisible();
});

test('wrong current password stays signed in, reports failure and does not refresh the session', async ({ page }) => {
  let refreshes = 0; const writes: unknown[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/refresh')) { refreshes++; return respond(route, { access_token: 'fresh-access' }); }
    if (path.endsWith('/password')) { writes.push(route.request().postDataJSON()); return respond(route, null, 401, 'Invalid current password'); }
    return commonResponse(route);
  });
  await addSession(page); await page.goto('/profile'); await page.getByRole('tab', { name: '修改密码' }).click();
  await page.getByLabel('当前密码', { exact: true }).fill('Incorrect123');
  await page.getByLabel('新密码', { exact: true }).fill('Synthetic456');
  await page.getByLabel('确认新密码', { exact: true }).fill('Synthetic456');
  await page.getByRole('tabpanel', { name: '修改密码' }).getByRole('button', { name: /^提\s*交$/ }).click();
  await expect(page.getByText('密码修改失败，请检查当前密码并重试')).toBeVisible();
  expect(writes).toEqual([{ currentPassword: 'Incorrect123', password: 'Synthetic456' }]);
  await page.getByLabel('当前密码', { exact: true }).fill('StillWrong123');
  await page.getByRole('tabpanel', { name: '修改密码' }).getByRole('button', { name: /提\s*交$/ }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ currentPassword: 'StillWrong123', password: 'Synthetic456' });
  expect(refreshes).toBe(0); expect((await storedAuth(page)).isAuthenticated).toBe(true);
  await expect(page).toHaveURL(/\/profile$/);
});

test('password change refreshes an expired access token through a read and clears auth only after success', async ({ page }) => {
  let expired = false, refreshes = 0; const writes: Array<{ body: unknown; authorization: string }> = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/me') && expired && route.request().headers().authorization !== 'Bearer fresh-access') return respond(route, null, 401, 'Expired access');
    if (path.endsWith('/refresh')) { refreshes++; return respond(route, { access_token: 'fresh-access' }); }
    if (path.endsWith('/password')) {
      expect(new URL(route.request().url()).search).toBe('');
      writes.push({ body: route.request().postDataJSON(), authorization: route.request().headers().authorization });
      return respond(route, { success: true }, 200, 'success', { 'set-cookie': 'zucker-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
    }
    return commonResponse(route);
  });
  await addSession(page); await page.goto('/profile'); await expect(page.getByLabel('姓名', { exact: true })).toHaveValue('合成管理员');
  expired = true;
  await page.getByRole('tab', { name: '修改密码' }).click();
  await page.getByLabel('当前密码', { exact: true }).fill('Synthetic123');
  await page.getByLabel('新密码', { exact: true }).fill('Synthetic456');
  await page.getByLabel('确认新密码', { exact: true }).fill('Synthetic456');
  await page.getByRole('tabpanel', { name: '修改密码' }).getByRole('button', { name: /^提\s*交$/ }).click();
  await expect(page).toHaveURL(/\/login$/); expect(refreshes).toBe(1);
  expect(writes).toEqual([{ body: { currentPassword: 'Synthetic123', password: 'Synthetic456' }, authorization: 'Bearer fresh-access' }]);
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
  await addSession(page); await page.goto('/profile'); await expect(page.getByLabel('姓名', { exact: true })).toHaveValue('合成管理员');
  await page.locator('header').getByText('synthetic', { exact: true }).first().hover(); await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page.getByText('退出未完成，请重试')).toBeVisible();
  expect((await storedAuth(page)).isAuthenticated).toBe(true); await expect(page).toHaveURL(/\/profile$/);
  failLogout = false;
  await page.locator('header').getByText('synthetic', { exact: true }).first().hover(); await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page).toHaveURL(/\/login$/); expect(logoutCalls).toBe(2);
  expect((await storedAuth(page)).isAuthenticated).toBe(false);
  expect((await page.context().cookies()).some(cookie => cookie.name === 'zucker-session')).toBe(false);
});
