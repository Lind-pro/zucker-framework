import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import {
  managementFixture,
  seedManagementRecords,
  seedManagementApiKeys,
} from './helpers/management-fixture';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_MANAGEMENT_BROWSER === '1'
    ? describe
    : describe.skip;
const origin = 'http://localhost:4320';
run('real Admin browser and PostgreSQL management', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>,
    browser: Browser,
    page: Page,
    vite: ChildProcess,
    owner: { userId: string; token: string };
  async function login(target = page, username = 'manageadmin') {
    await target.goto('/login');
    await target.getByPlaceholder('用户名', { exact: true }).fill(username);
    await target.getByPlaceholder('密码', { exact: true }).fill(f.password);
    await target.getByRole('button', { name: /登.*录/ }).click();
    await browserExpect(target).toHaveURL(/\/dashboard$/);
  }
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!, origin);
    owner = await f.member('browserowner');
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    vite = spawn(
      'pnpm',
      ['exec', 'vite', '--host', 'localhost', '--port', '4320', '--strictPort'],
      {
        cwd: resolve('../admin'),
        env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${address.port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    vite.stdout?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-2000);
    });
    vite.stderr?.on('data', (chunk) => {
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
      await new Promise((resolve) => setTimeout(resolve, 300));
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
    page.setDefaultTimeout(7000);
    page.setDefaultNavigationTimeout(15000);
    await login();
  }, 65_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({
        path: '/tmp/zucker-admin-failure.png',
        fullPage: true,
        animations: 'disabled',
      });
      console.info(
        'Admin failure view:',
        page.url(),
        (await page.locator('body').innerText()).slice(0, 2200),
      );
    }
  });
  afterAll(async () => {
    await browser?.close();
    if (vite && vite.exitCode === null) {
      vite.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => vite.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    }
    await f?.close();
  });
  it('loads real initialized menu groups and separates unavailable counts from zero', async () => {
    await browserExpect(page.getByText('用户与权限', { exact: true }).first()).toBeVisible();
    await browserExpect(page.getByText('内容与站点', { exact: true }).first()).toBeVisible();
    await page.route('**/api/users/_count', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 503, message: 'Synthetic unavailable' }),
      }),
    );
    await page.goto('/dashboard');
    await browserExpect(page.getByText('未能读取，不代表记录为零')).toBeVisible();
    await browserExpect(page.getByText('暂不可用', { exact: true })).toBeVisible();
    await page.unroute('**/api/users/_count');
    await page.screenshot({
      path: '/tmp/zucker-admin-dashboard.png',
      fullPage: true,
      animations: 'disabled',
    });
  });
  it('uses the actual health checks shape and distinguishes a failed read from a down dependency', async () => {
    await page.goto('/system-monitor');
    await browserExpect(page.getByText('尚未注册依赖探针')).toBeVisible();
    await page.route('**/api/health', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'down',
          checks: { database: { status: 'down', details: {} } },
          timestamp: new Date().toISOString(),
        }),
      }),
    );
    await page.getByRole('button', { name: /刷\s*新/ }).click();
    await browserExpect(page.getByText('database', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('异常', { exact: true }).first()).toBeVisible();
    await page.unroute('**/api/health');
    await page.route('**/api/health', (route) =>
      route.fulfill({ status: 502, body: 'Synthetic gateway failure' }),
    );
    await page.getByRole('button', { name: /刷\s*新/ }).click();
    await browserExpect(page.getByText('健康信息读取失败', { exact: true })).toBeVisible();
    await page.unroute('**/api/health');
  });
  it('edits real menu DTO fields and shows a retryable menu-loading failure', async () => {
    await page.goto('/menu');
    await page.getByRole('button', { name: '新建菜单' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('菜单名称', { exact: true }).fill('Synthetic menu group');
    await dialog.getByLabel('排序', { exact: true }).fill('99');
    await dialog.getByRole('button', { name: /确.*(?:认|定)/ }).click();
    await browserExpect(dialog).toHaveCount(0);
    const response = await request(f.app.getHttpServer())
      .get('/api/menu/all')
      .set('Authorization', `Bearer ${f.admin.token}`)
      .expect(200);
    expect(
      response.body.find((row: { name: string }) => row.name === 'Synthetic menu group'),
    ).toMatchObject({ sortOrder: 99, status: true });
    await page.route('**/api/menu/tree', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 503, message: 'Synthetic unavailable' }),
      }),
    );
    await page.goto('/menu');
    await browserExpect(page.getByText('菜单加载失败', { exact: true })).toBeVisible();
    await page.unroute('**/api/menu/tree');
    await page.getByRole('button', { name: /重\s*试/ }).click();
    await browserExpect(page.getByText('菜单加载失败', { exact: true })).toHaveCount(0);
  });
  it('creates and publishes CMS content through the actual Admin form and updates public API output', async () => {
    await page.goto('/content');
    await page.getByRole('button', { name: '新建内容', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('地址路径', { exact: true }).fill('admin-browser-post');
    await dialog.getByLabel('标题', { exact: true }).fill('管理端真实内容');
    await dialog.getByLabel('正文（Markdown）', { exact: true }).fill('通过管理端保存并发布。');
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    const row = page.getByRole('row').filter({ hasText: '管理端真实内容' });
    await browserExpect(row).toBeVisible();
    await row.getByText('发布已保存版本', { exact: true }).click();
    await browserExpect(row.getByText('已发布', { exact: true })).toBeVisible();
    const publicResult = await request(f.app.getHttpServer())
      .get('/api/content/public/entry?kind=post&locale=zh&slug=admin-browser-post')
      .expect(200);
    expect(publicResult.body.title).toBe('管理端真实内容');
    await row.getByText('取消发布', { exact: true }).click();
    await browserExpect(row.getByText('草稿', { exact: true })).toBeVisible();
    await request(f.app.getHttpServer())
      .get('/api/content/public/entry?kind=post&locale=zh&slug=admin-browser-post')
      .expect(404);
    await page.screenshot({
      path: '/tmp/zucker-admin-content.png',
      fullPage: true,
      animations: 'disabled',
    });
  });
  it('retries an uncertain credit grant with the same key and gives the owner spendable lots once', async () => {
    await page.goto('/credit');
    await page.getByRole('button', { name: '发放积分', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('账户ID', { exact: true }).fill(owner.userId);
    await dialog.getByLabel('积分数量', { exact: true }).fill('25');
    await dialog.getByLabel('发放原因', { exact: true }).fill('Synthetic browser support');
    const keys: string[] = [];
    let first = true;
    await page.route('**/api/management/credits/*/grants', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (first) {
        first = false;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ status: 503, message: 'Synthetic response loss after commit' }),
        });
      } else await route.continue();
    });
    await dialog.getByRole('button', { name: '确认发放', exact: true }).click();
    await browserExpect(
      page.getByText('结果未确认；保持表单内容不变重试会复用同一请求编号'),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '发放积分', exact: true }).click();
    await dialog.getByLabel('账户ID', { exact: true }).fill(owner.userId);
    await dialog.getByLabel('积分数量', { exact: true }).fill('25');
    await dialog.getByLabel('发放原因', { exact: true }).fill('Synthetic browser support');
    await dialog.getByRole('button', { name: '确认发放', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    await page.unroute('**/api/management/credits/*/grants');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const result = await request(f.app.getHttpServer())
      .get(`/api/management/credits/${owner.userId}/balance`)
      .set('Authorization', `Bearer ${f.admin.token}`)
      .expect(200);
    expect(result.body.available).toBe(25);
    expect(await f.database.model('creditLots').count({ where: { userId: owner.userId } })).toBe(1);
    await page.getByText('查看账户额度', { exact: true }).click();
    await browserExpect(page.getByText('可用额度', { exact: true })).toBeVisible();
    await page.screenshot({
      path: '/tmp/zucker-admin-credits.png',
      fullPage: true,
      animations: 'disabled',
    });
  });
  it('persists only the actual site configuration and disables legacy modules without requests', async () => {
    await page.goto('/config');
    await page.getByLabel('网站名称', { exact: true }).fill('管理端站点配置');
    await page.getByRole('button', { name: '保存站点配置', exact: true }).click();
    await browserExpect(page.getByText('站点配置已保存', { exact: true })).toBeVisible();
    expect(
      (
        await request(f.app.getHttpServer())
          .get('/api/content/public/settings?locale=zh')
          .expect(200)
      ).body.name,
    ).toBe('管理端站点配置');
    await browserExpect(page.getByLabel('SMTP 主机')).toHaveCount(0);
    const calls: string[] = [];
    const listener = (req: { url(): string }) => {
      if (/\/api\/(?:tenant|i18n|notification\/template)/.test(req.url())) calls.push(req.url());
    };
    page.on('request', listener);
    for (const path of ['/tenant', '/i18n', '/notification/template']) {
      await page.goto(path);
      await browserExpect(page.getByText('此功能尚未启用', { exact: true })).toBeVisible();
    }
    page.off('request', listener);
    expect(calls).toEqual([]);
  });
  it('blocks unauthorized direct Admin routes and APIs without loading CMS data', async () => {
    const context = await browser.newContext({ baseURL: origin });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    const memberPage = await context.newPage();
    memberPage.setDefaultTimeout(7000);
    await login(memberPage, 'browserowner');
    const calls: string[] = [];
    memberPage.on('request', (req) => {
      if (req.url().includes('/api/content/manage')) calls.push(req.url());
    });
    await memberPage.goto('/content');
    await browserExpect(memberPage.getByText('没有访问权限', { exact: true })).toBeVisible();
    expect(calls).toEqual([]);
    await request(f.app.getHttpServer())
      .get('/api/content/manage/entries')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(403);
    await context.close();
  });
  it('renders projected billing and runtime records without private fields on desktop and narrow screens', async () => {
    await seedManagementRecords(f, owner.userId);
    await page.goto('/records/orders');
    await browserExpect(
      page.getByText('Synthetic safe offer', { exact: true }).first(),
    ).toBeVisible();
    await browserExpect(page.getByText('10.00 USD', { exact: true }).first()).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE-');
    await page.getByText('详情', { exact: true }).first().click();
    await browserExpect(page.getByText('订单详情', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: /关\s*闭/ })
      .last()
      .click();
    await page.goto('/records/jobs');
    await browserExpect(page.getByText('synthetic.task', { exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE-TASK');
    await page.goto('/records/deliveries');
    await browserExpect(page.getByText('projection-delivery', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/records/subscriptions');
    await browserExpect(page.getByText('Synthetic safe offer', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
    ).toBe(true);
    await page.screenshot({
      path: '/tmp/zucker-admin-records-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  it('shows refund-pending amounts separately from frozen, available and book balances', async () => {
    await request(f.app.getHttpServer()).post(`/api/management/credits/${owner.userId}/grants`)
      .set('Authorization', `Bearer ${f.admin.token}`).set('Origin', origin).set('Idempotency-Key', 'refund-blocked-ui-seed')
      .send({ amount: 110, description: 'Synthetic refund projection UI' }).expect(200);
    const balancePath = `**/api/management/credits/${owner.userId}/balance`;
    const lotsPath = `**/api/management/credits/${owner.userId}/lots?*`;
    await page.route(balancePath, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: 20, frozen: 30, refundBlocked: 60, expired: 5, bookBalance: 110, pendingExpiry: 0 }) }));
    await page.route(lotsPath, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [
      { id: 'refund-source', source: 'purchase', amount: 80, availableAmount: 0, frozenAmount: 20, refundBlockedAmount: 60, status: 'refund_pending' },
      { id: 'ordinary-source', source: 'purchase', amount: 20, availableAmount: 20, frozenAmount: 0, refundBlockedAmount: 0, status: 'available' },
    ], total: 2 }) }));
    try {
      await page.goto('/credit'); await page.getByText('查看账户额度', { exact: true }).first().click();
      const drawer = page.getByRole('dialog', { name: '账户额度' });
      await browserExpect(drawer.locator('.ant-descriptions-row').filter({ hasText: '可用额度' }).locator('.ant-descriptions-item-content')).toHaveText('20');
      await browserExpect(drawer.locator('.ant-descriptions-row').filter({ hasText: '账面余额' }).locator('.ant-descriptions-item-content')).toHaveText('110');
      await browserExpect(drawer.locator('.ant-descriptions-row').filter({ hasText: '保留额度' }).locator('.ant-descriptions-item-content')).toHaveText('30');
      await browserExpect(drawer.locator('.ant-descriptions-row').filter({ hasText: '退款待处理额度' }).locator('.ant-descriptions-item-content')).toHaveText('60');
      const pending = drawer.locator('tr[data-row-key="refund-source"]');
      await browserExpect(pending).toContainText('退款待处理');
      await browserExpect(pending.getByRole('cell').nth(2)).toHaveText('0');
      await browserExpect(pending.getByRole('cell').nth(3)).toHaveText('20');
      await browserExpect(pending.getByRole('cell').nth(4)).toHaveText('60');
      await page.setViewportSize({ width: 390, height: 844 });
      await browserExpect.poll(async () => (await drawer.boundingBox())?.width ?? 1000).toBeLessThanOrEqual(390);
      await browserExpect(drawer.getByText('可用额度', { exact: true })).toBeInViewport();
      await browserExpect(drawer.getByText('这部分额度正在等待退款回收处理，不与保留额度重复计算。账面余额不是当前可消费额度。')).toBeVisible();
      await browserExpect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
      await page.screenshot({ path: '/private/tmp/zucker-admin-refund-blocked-mobile.png', fullPage: true });
    } finally { await page.unroute(balancePath); await page.unroute(lotsPath); await page.setViewportSize({ width: 1440, height: 1000 }); }
  });
  it('shows read-only connection sources/missing fields and safe API key metadata', async () => {
    await page.goto('/connections');
    await browserExpect(page.getByText('Stripe', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('STRIPE_WEBHOOK_SECRET', { exact: true })).toBeVisible();
    await browserExpect(
      page.getByText('Server 环境配置（只读）', { exact: true }).first(),
    ).toBeVisible();
    await browserExpect(page.getByRole('textbox')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('SYNTHETIC-SECRET-NEVER-EXPOSE');
    await seedManagementApiKeys(f, owner.userId);
    await page.goto('/records/api-keys');
    await browserExpect(page.getByText('Synthetic active key', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('zk_api_active', { exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/PRIVATE-HASH|secretKey/);
    await browserExpect(page.getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
  });
});
