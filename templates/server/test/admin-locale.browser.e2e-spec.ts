import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { connectionBrowserFixture } from './helpers/connection-browser-fixture';
import { artifact, isolatedContext, launchBrowser, newPage, noHorizontalOverflow, record, startAdmin, type AdminServer } from './helpers/fe-admin-browser';
import { loginAs, presetLocale, warmUp, type AdminLocale } from './helpers/admin-locale-browser';

const run = process.env.TEST_DATABASE_URL && process.env.RUN_ADMIN_LOCALE_BROWSER === '1' ? describe : describe.skip;
const port = 4327;

run('Admin language switching through real authentication and generated descriptors', () => {
  let f: Awaited<ReturnType<typeof connectionBrowserFixture>>, admin: AdminServer, browser: Browser, page: Page;
  const pageErrors: string[] = [];
  /** Switch with whichever language select is visible (header on desktop, login page). */
  async function language(value: AdminLocale) {
    await page.getByRole('combobox', { name: /^(语言|Language)$/ }).selectOption(value);
    await browserExpect(page.locator('html')).toHaveAttribute('lang', value);
  }
  const sidebar = () => page.locator('aside nav');
  beforeAll(async () => {
    f = await connectionBrowserFixture(process.env.TEST_DATABASE_URL!, `http://localhost:${port}`);
    await f.database.model('menus').update({ where: { id: 'starter:users' }, data: { name: '用户工作台（自定义）' } });
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
    admin = await startAdmin(port, address.port);
    browser = await launchBrowser();
    // The template admin defaults to English (VITE_DEFAULT_LOCALE); this spec starts in Chinese.
    const context = await isolatedContext(browser, admin.origin);
    await presetLocale(context, 'zh-CN');
    page = await newPage(context);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await warmUp(page);
    await loginAs(page, 'connectionadmin', f.password, 'zh-CN');
    await browserExpect(page).toHaveURL(/\/dashboard$/);
  }, 65_000);
  beforeEach(async () => {
    await page.goto('/dashboard');
    // Session restore (cookie refresh) must settle before switching or navigating again.
    await browserExpect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await language('en-US');
  });
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({ path: artifact('admin-locale-failure.png'), fullPage: true, animations: 'disabled' });
      console.info('Locale failure view:', page.url(), (await page.locator('body').ariaSnapshot()).slice(0, 4000));
    }
    await page?.unrouteAll({ behavior: 'ignoreErrors' });
  });
  afterAll(async () => {
    await browser?.close();
    await admin?.stop();
    await f?.close();
  });

  it('persists language and translates starter navigation while preserving customized menu names', async () => {
    await browserExpect(page).toHaveTitle('Administration');
    await browserExpect(page.getByText('Quick links', { exact: true })).toBeVisible();
    await sidebar().getByText('Users & access', { exact: true }).click();
    await browserExpect(sidebar().getByRole('link', { name: '用户工作台（自定义）', exact: true })).toBeVisible();
    await sidebar().getByText('Billing & credits', { exact: true }).click();
    await browserExpect(sidebar().getByRole('link', { name: '订单', exact: true })).toBeVisible();
    // An unchanged starter page keeps its translated title next to the customized records.
    await browserExpect(sidebar().getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
    await page.reload();
    await browserExpect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await browserExpect(page.getByText('Quick links', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('zucker-admin-locale'))).toBe('en-US');
    await language('zh-CN');
    await browserExpect(page.getByText('常用入口', { exact: true })).toBeVisible();
    await browserExpect(page).toHaveTitle('管理后台');
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
    await page.goto('/config');
    await page.getByRole('textbox', { name: 'Site name', exact: true }).fill('用户自己的站点名');
    const initialReads = reads;
    await language('zh-CN');
    await browserExpect(page.getByRole('textbox', { name: '网站名称', exact: true })).toHaveValue('用户自己的站点名');
    await language('en-US');
    await browserExpect(page.getByRole('textbox', { name: 'Site name', exact: true })).toHaveValue('用户自己的站点名');
    expect(reads).toBe(initialReads);
    await browserExpect(page.getByRole('button', { name: 'Save site settings', exact: true })).toBeVisible();
  });

  it('opens every connection profile with English controls and leaves secrets and saves disabled until edited', async () => {
    await page.goto('/connections');
    const profiles = (await f.settings.list()).profiles;
    expect(profiles.length).toBe(16);
    const table = page.getByRole('table', { name: 'Connections', exact: true });
    await browserExpect(table.getByRole('columnheader', { name: 'Configuration source', exact: true })).toBeVisible();
    const open = table.getByRole('button', { name: /^(Edit|View) settings$/ });
    // Every saved-settings profile has exactly one editor action (rows merge status and profiles by id).
    await browserExpect(open).toHaveCount(profiles.length);
    const secrets = profiles.flatMap((profile) => profile.fields.filter((item) => item.type === 'secret' && item.value));
    for (let index = 0; index < profiles.length; index++) {
      await open.nth(index).click();
      const dialog = page.getByRole('dialog', { name: /^(Edit|View) connection · / });
      await browserExpect(dialog).toBeVisible();
      await browserExpect(dialog.getByText(/^Saved revision \d+; running revision \d+$/)).toBeVisible();
      const save = dialog.getByRole('button', { name: 'Save encrypted', exact: true });
      if (await save.count()) await browserExpect(save).toBeDisabled();
      // Secrets are never echoed back into the editor.
      const text = await dialog.innerText();
      for (const secret of secrets) expect(text).not.toContain(String(secret.value));
      await dialog.getByRole('button', { name: /^(Cancel|Close)$/ }).last().click();
      await browserExpect(dialog).toHaveCount(0);
    }
  });

  it('localizes server-provided connection descriptor text (names, categories, field labels, notes) in English', async () => {
    const cjk = /[㐀-鿿（）；，、。]/;
    await page.goto('/connections');
    const table = page.getByRole('table', { name: 'Connections', exact: true });
    const google = table.getByRole('row').filter({ has: page.getByText('Google sign-in', { exact: true }) });
    await browserExpect(google).toBeVisible();
    await browserExpect(google.getByRole('cell', { name: 'Sign-in', exact: true })).toBeVisible();
    await browserExpect(table.getByText('Site ads, referrals and support', { exact: true })).toBeVisible();
    await browserExpect(table.getByText('OpenAI-compatible API', { exact: true })).toBeVisible();
    await browserExpect(table.getByText(/^Only local configuration and dependencies are checked\./).first()).toBeVisible();
    // Every server-provided name, category and note in the table has an English translation.
    expect(await table.innerText()).not.toMatch(cjk);
    const open = table.getByRole('button', { name: /^(Edit|View) settings$/ });
    const profiles = (await f.settings.list()).profiles;
    await browserExpect(open).toHaveCount(profiles.length);
    for (let index = 0; index < profiles.length; index++) {
      await open.nth(index).click();
      const dialog = page.getByRole('dialog', { name: /^(Edit|View) connection · / });
      await browserExpect(dialog).toBeVisible();
      // Field labels and descriptions, the dialog title and the action selects are all English.
      expect(await dialog.innerText()).not.toMatch(cjk);
      await dialog.getByRole('button', { name: /^(Cancel|Close)$/ }).last().click();
      await browserExpect(dialog).toHaveCount(0);
    }
    await google.getByRole('button', { name: 'Edit settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit connection · Google sign-in', exact: true });
    await browserExpect(dialog.getByRole('combobox', { name: 'OAuth sign-in action', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    // Switching back shows the server text unchanged.
    await language('zh-CN');
    await browserExpect(page.getByRole('table', { name: '连接配置', exact: true }).getByText('Google 登录', { exact: true })).toBeVisible();
  });

  it('uses English CRUD, pagination and required-field validation while preserving stored names', async () => {
    await page.goto('/users');
    await browserExpect(page.getByRole('button', { name: 'Create user', exact: true })).toBeVisible();
    await browserExpect(page.getByText(/^Page 1 of 1, \d+ records$/)).toBeVisible();
    await page.getByRole('button', { name: 'Create user', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create user', exact: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog.getByText('Username is required', { exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('localecreateduser');
    await dialog.getByRole('textbox', { name: 'Email', exact: true }).fill('localecreateduser@example.invalid');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('保留用户姓名');
    await dialog.getByRole('textbox', { name: 'Password', exact: true }).fill(f.password);
    await page.route('**/api/users', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic create failure' }) })
        : route.continue(),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog.getByText(/^The save was not confirmed\. .*Your draft is kept\.$/)).toBeVisible();
    await browserExpect(dialog.getByRole('textbox', { name: 'Username', exact: true })).toHaveValue('localecreateduser');
    await browserExpect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('保留用户姓名');
    await page.unroute('**/api/users');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    await browserExpect(record(page, 'localecreateduser')).toContainText('保留用户姓名');
    const created = (await f.database
      .model('users')
      .findFirst({ where: { username: 'localecreateduser' }, select: { id: true, typeId: true } })) as { id: string; typeId: string };
    expect(created.typeId).toBe('member');
    await f.database.model('users').update({ where: { id: created.id }, data: { typeId: 'consumer-special' } });
    await page.reload();
    await record(page, 'localecreateduser').getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit user', exact: true });
    await browserExpect(editor.getByRole('textbox', { name: 'Username', exact: true })).toBeDisabled();
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('用户编辑后的姓名');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(editor).toHaveCount(0);
    expect(await f.database.model('users').findUnique({ where: { id: created.id }, select: { typeId: true, name: true } })).toEqual({
      typeId: 'consumer-special',
      name: '用户编辑后的姓名',
    });
  });

  it('shows translated profile failures and recovers real data after Retry in both languages', async () => {
    await page.route('**/api/authorize/me', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic profile read failure' }) }),
    );
    // Navigate inside the app: a full reload would also fail session restore on the same endpoint.
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Profile', exact: true }).click();
    await browserExpect(page.getByText(/^Could not load your profile/)).toBeVisible();
    await language('zh-CN');
    await browserExpect(page.getByText(/^个人资料读取失败/)).toBeVisible();
    await page.unroute('**/api/authorize/me');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await browserExpect(page.getByText('connectionadmin@example.invalid')).toBeVisible();
    await language('en-US');
    await browserExpect(page.getByText(/^Could not load your profile/)).toHaveCount(0);
    await browserExpect(page.getByRole('tab', { name: 'Basic information', exact: true })).toBeVisible();
  });

  it('localizes read-only management, credit and refund page headings at a narrow viewport', async () => {
    await page.route('**/api/billing/refunds?*', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [], total: 0, page: 1, pageSize: 20 }) }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      for (const [path, title] of [
        ['/credit', 'Credits'],
        ['/records/orders', 'Orders'],
        ['/refunds', 'Refunds'],
      ] as const) {
        await page.goto(path);
        await browserExpect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
        await browserExpect(page.getByRole('button', { name: 'Search', exact: true }).first()).toBeVisible();
        await browserExpect.poll(() => noHorizontalOverflow(page)).toBe(true);
      }
      await page.screenshot({ path: artifact('admin-locale-mobile.png'), fullPage: true, animations: 'disabled' });
    } finally {
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    expect(pageErrors).toEqual([]);
  });
});
