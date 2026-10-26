import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { connectionBrowserFixture } from './helpers/connection-browser-fixture';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_ADMIN_LOCALE_BROWSER === '1'
    ? describe
    : describe.skip;
const origin = 'http://localhost:4327';
run('Admin language switching through real authentication and generated descriptors', () => {
  let f: Awaited<ReturnType<typeof connectionBrowserFixture>>,
    browser: Browser,
    page: Page,
    vite: ChildProcess;
  async function language(value: 'English' | '中文') {
    await page.getByRole('combobox', { name: 'Language / 语言', exact: true }).press('ArrowDown');
    await page.locator('.ant-select-dropdown:visible').getByText(value, { exact: true }).click();
    await browserExpect(page.locator('html')).toHaveAttribute(
      'lang',
      value === 'English' ? 'en-US' : 'zh-CN',
    );
  }
  beforeAll(async () => {
    f = await connectionBrowserFixture(process.env.TEST_DATABASE_URL!, origin);
    await f.database
      .model('menus')
      .update({ where: { id: 'starter:users' }, data: { name: '用户工作台（自定义）' } });
    await f.database.model('menus').create({
      data: {
        id: 'locale-custom-order-name',
        name: '订单',
        path: '/profile',
        parentId: 'starter:commerce',
        sortOrder: 99,
        status: true,
        permissions: [],
      },
    });
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    vite = spawn(
      'pnpm',
      ['exec', 'vite', '--host', 'localhost', '--port', '4327', '--strictPort'],
      {
        cwd: resolve('../admin'),
        env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${address.port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    for (const stream of [vite.stdout, vite.stderr])
      stream?.on('data', (chunk) => {
        output = (output + String(chunk)).slice(-2000);
      });
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (vite.exitCode !== null) throw new Error(`Admin startup failed: ${output}`);
      try {
        if ((await fetch(origin, { signal: AbortSignal.timeout(1500) })).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 250));
    }
    if (!ready) throw new Error(`Admin startup exceeded 45 seconds: ${output}`);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
    });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(15000);
    await page.goto('/login');
    await page.getByPlaceholder('用户名', { exact: true }).fill('connectionadmin');
    await page.getByPlaceholder('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: /登.*录/ }).click();
    await browserExpect(page).toHaveURL(/\/dashboard$/);
  }, 65_000);
  beforeEach(async () => {
    await page.goto('/dashboard');
    await language('English');
  });
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({
        path: '/private/tmp/zucker-admin-locale-failure.png',
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page?.unrouteAll({ behavior: 'ignoreErrors' });
  });
  afterAll(async () => {
    await browser?.close();
    if (vite && vite.exitCode === null) {
      vite.kill('SIGTERM');
      await Promise.race([
        new Promise((done) => vite.once('exit', done)),
        new Promise((done) => setTimeout(done, 2500)),
      ]);
    }
    await f?.close();
  });
  it('persists language and translates starter navigation while preserving customized menu names', async () => {
    await language('English');
    await browserExpect(page).toHaveTitle('Administration');
    await browserExpect(page.getByText('Quick links', { exact: true })).toBeVisible();
    await page.getByText('Users & access', { exact: true }).first().click();
    await browserExpect(page.getByText('用户工作台（自定义）', { exact: true })).toBeVisible();
    await page.getByText('Billing & credits', { exact: true }).first().click();
    await browserExpect(page.getByText('订单', { exact: true })).toBeVisible();
    await page.reload();
    await browserExpect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await browserExpect(page.getByText('Quick links', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('zucker-admin-locale'))).toBe('en');
  });
  it('keeps an unsaved site form and its business text across language switches without refetching', async () => {
    let reads = 0;
    await page.route('**/api/content/manage/settings', (route) => {
      reads++;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          usingDefaults: false,
          settings: {
            name: 'Synthetic site',
            theme: 'default',
            appearance: 'dark',
            description: { zh: '', en: '' },
            navigation: { zh: [], en: [] },
            footerLinks: { zh: [], en: [] },
          },
        }),
      });
    });
    try {
      await page.goto('/config');
      await page.getByLabel('Site name', { exact: true }).fill('用户自己的站点名');
      const initialReads = reads;
      await language('中文');
      await browserExpect(page.getByLabel('网站名称', { exact: true })).toHaveValue(
        '用户自己的站点名',
      );
      await language('English');
      await browserExpect(page.getByLabel('Site name', { exact: true })).toHaveValue(
        '用户自己的站点名',
      );
      expect(reads).toBe(initialReads);
      await browserExpect(
        page.getByRole('button', { name: 'Save site settings', exact: true }),
      ).toBeVisible();
    } finally {
      await page.unroute('**/api/content/manage/settings');
    }
  });
  it('localizes all connection descriptors and keeps protocol values and secret controls intact', async () => {
    await page.goto('/connections');
    const profiles = (await f.settings.list()).profiles;
    expect(profiles.length).toBe(16);
    await browserExpect(page.locator('tr[data-row-key="identity-google"]')).toContainText(
      'Google sign-in',
    );
    expect(await page.getByRole('table').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
    for (const profile of profiles) {
      await page
        .locator(`tr[data-row-key="${profile.id}"]`)
        .getByRole('button', { name: 'Edit configuration', exact: true })
        .click();
      const dialog = page.getByRole('dialog');
      await browserExpect(dialog).toBeVisible();
      expect(await dialog.innerText()).not.toMatch(/[\u4e00-\u9fff]/);
      await browserExpect(
        dialog.getByRole('button', { name: 'Save encrypted settings', exact: true }),
      ).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
  });
  it('uses English CRUD, pagination and required-field validation while preserving stored names', async () => {
    await page.goto('/users');
    await browserExpect(page.getByRole('button', { name: /Create user/ })).toBeVisible();
    await browserExpect(page.locator('.ant-pagination-total-text')).toContainText('of');
    await page.getByRole('button', { name: /Create user/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^(OK|Submit|Confirm)$/ }).click();
    await browserExpect(dialog.locator('.ant-form-item-explain-error').first()).toContainText(
      'Please enter Username',
    );
    await dialog.getByLabel('Username', { exact: true }).fill('localecreateduser');
    await dialog.getByLabel('Email', { exact: true }).fill('localecreateduser@example.invalid');
    await dialog.getByLabel('Name', { exact: true }).fill('保留用户姓名');
    await dialog.getByLabel('Password', { exact: true }).fill(f.password);
    await page.route('**/api/users', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Synthetic create failure' }),
          })
        : route.continue(),
    );
    await dialog.getByRole('button', { name: /^(OK|Submit|Confirm)$/ }).click();
    await browserExpect(
      page.getByText(
        'User save was not confirmed. Check the account, access and connection, then retry. Your draft is kept.',
        { exact: true },
      ),
    ).toBeVisible();
    await browserExpect(dialog.getByLabel('Username', { exact: true })).toHaveValue(
      'localecreateduser',
    );
    await browserExpect(dialog.getByLabel('Name', { exact: true })).toHaveValue('保留用户姓名');
    await page.unroute('**/api/users');
    const retryCreate = dialog.getByRole('button', { name: /OK$/ });
    await browserExpect(retryCreate).not.toHaveClass(/ant-btn-loading/);
    await retryCreate.click();
    await browserExpect(dialog).toHaveCount(0);
    await browserExpect(page.getByText('保留用户姓名', { exact: true })).toBeVisible();
    const created = (await f.database
      .model('users')
      .findFirst({ where: { username: 'localecreateduser' }, select: { id: true, typeId: true } })) as { id: string; typeId: string };
    expect(created.typeId).toBe('member');
    await f.database
      .model('users')
      .update({ where: { id: created.id }, data: { typeId: 'consumer-special' } });
    await page.reload();
    await page
      .getByRole('row')
      .filter({ hasText: 'localecreateduser' })
      .getByText('Edit', { exact: true })
      .click();
    const editor = page.getByRole('dialog');
    await browserExpect(editor.getByLabel('Username', { exact: true })).toBeDisabled();
    await editor.getByLabel('Name', { exact: true }).fill('用户编辑后的姓名');
    await editor.getByRole('button', { name: /^(OK|Submit|Confirm)$/ }).click();
    await browserExpect(editor).toHaveCount(0);
    expect(
      await f.database
        .model('users')
        .findUnique({ where: { id: created.id }, select: { typeId: true, name: true } }),
    ).toEqual({ typeId: 'consumer-special', name: '用户编辑后的姓名' });
  });
  it('shows translated profile failures and recovers real data after Retry in both languages', async () => {
    await page.route('**/api/authorize/me', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Synthetic profile read failure' }),
      }),
    );
    await page.goto('/profile');
    await browserExpect(
      page.getByText('Could not load your profile', { exact: true }),
    ).toBeVisible();
    await language('中文');
    await browserExpect(page.getByText('个人资料读取失败', { exact: true })).toBeVisible();
    await page.unroute('**/api/authorize/me');
    await page.getByRole('button', { name: /重\s*试/ }).click();
    await browserExpect(
      page.getByText('connectionadmin@example.invalid', { exact: true }),
    ).toBeVisible();
    await language('English');
    await browserExpect(page.getByText('Could not load your profile', { exact: true })).toHaveCount(
      0,
    );
  });
  it('localizes read-only management, credit and refund page headings at a narrow viewport', async () => {
    await page.route('**/api/billing/refunds?*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: [], total: 0, page: 1, pageSize: 20 }),
      }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [path, title] of [
      ['/credit', 'Credit transactions'],
      ['/records/orders', 'Orders'],
      ['/refunds', 'Refunds'],
    ] as const) {
      await page.goto(path);
      await browserExpect(page.getByText(title, { exact: true }).last()).toBeVisible();
      await browserExpect(page.getByRole('button', { name: /Query|Search/ }).first()).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2),
      ).toBe(true);
    }
    await page.screenshot({
      path: '/private/tmp/zucker-admin-locale-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.unroute('**/api/billing/refunds?*');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
});
