import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expect as browserExpect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import request from 'supertest';
import {
  managementFixture,
  seedManagementRecords,
  seedManagementApiKeys,
} from './helpers/management-fixture';
import {
  artifact,
  definition,
  isolatedContext,
  labeled,
  launchBrowser,
  login,
  newPage,
  noHorizontalOverflow,
  record,
  startAdmin,
  visible,
  type AdminServer,
} from './helpers/fe-admin-browser';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_MANAGEMENT_BROWSER === '1'
    ? describe
    : describe.skip;
const origin = 'http://localhost:4320';
run('real Admin browser and PostgreSQL management', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>,
    browser: Browser,
    context: BrowserContext,
    page: Page,
    admin: AdminServer,
    owner: { userId: string; token: string };
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!, origin);
    owner = await f.member('browserowner');
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    admin = await startAdmin(4320, address.port);
    browser = await launchBrowser();
    context = await isolatedContext(browser, origin);
    page = await newPage(context);
    await login(page, 'manageadmin', f.password);
    await browserExpect(page).toHaveURL(/\/dashboard$/);
  }, 65_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({ path: artifact('management-failure.png'), fullPage: true, animations: 'disabled' });
      console.info('Admin failure view:', page.url(), (await page.locator('body').innerText()).slice(0, 2200));
    }
  });
  afterAll(async () => {
    await browser?.close();
    await admin?.stop();
    await f?.close();
  });
  it('loads real initialized menu groups and separates unavailable counts from zero', async () => {
    const navigation = page.getByRole('complementary', { name: '管理功能' });
    await browserExpect(navigation.getByText('用户与权限', { exact: true })).toBeVisible();
    await browserExpect(navigation.getByText('内容与站点', { exact: true })).toBeVisible();
    await page.route('**/api/users/_count', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 503, message: 'Synthetic unavailable' }),
      }),
    );
    await page.goto('/dashboard');
    const users = page.getByText('用户总数', { exact: true }).locator('..');
    await browserExpect(users.getByText('暂不可用', { exact: true })).toBeVisible();
    await browserExpect(users.getByText('未能读取，不代表记录为零')).toBeVisible();
    await browserExpect(users.getByRole('link', { name: '查看记录' })).toHaveCount(0);
    // A readable count stays a number with a link, even when it is zero.
    const roles = page.getByText('角色数量', { exact: true }).locator('..');
    await browserExpect(roles.getByText(/^\d+$/)).toBeVisible();
    await browserExpect(roles.getByRole('link', { name: '查看记录' })).toBeVisible();
    await page.unroute('**/api/users/_count');
    await page.screenshot({ path: artifact('admin-dashboard.png'), fullPage: true, animations: 'disabled' });
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
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await browserExpect(page.getByText('database', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('异常', { exact: true }).first()).toBeVisible();
    await page.unroute('**/api/health');
    await page.route('**/api/health', (route) =>
      route.fulfill({ status: 502, body: 'Synthetic gateway failure' }),
    );
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await browserExpect(page.getByText('健康信息读取失败', { exact: true })).toBeVisible();
    await page.unroute('**/api/health');
  });
  it('edits real menu DTO fields and shows a retryable menu-loading failure', async () => {
    await page.goto('/menu');
    await page.getByRole('button', { name: '新建菜单' }).click();
    const dialog = page.getByRole('dialog', { name: '新建菜单' });
    await labeled(dialog, '菜单名称').fill('Synthetic menu group');
    await labeled(dialog, '排序').fill('99');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    const response = await request(f.app.getHttpServer())
      .get('/api/menu/all')
      .set('Authorization', `Bearer ${f.admin.token}`)
      .expect(200);
    expect(
      response.body.find((row: { name: string }) => row.name === 'Synthetic menu group'),
    ).toMatchObject({ sortOrder: 99, status: true, path: null });
    await page.route('**/api/menu/tree', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 503, message: 'Synthetic unavailable' }),
      }),
    );
    await page.goto('/menu');
    const failure = page.getByRole('alert').filter({ hasText: '菜单加载失败' });
    await browserExpect(failure).toBeVisible();
    await page.unroute('**/api/menu/tree');
    await failure.getByRole('button', { name: '重试', exact: true }).click();
    await browserExpect(page.getByText(/菜单加载失败/)).toHaveCount(0);
  });
  it('creates and publishes CMS content through the actual Admin form and updates public API output', async () => {
    await page.goto('/content');
    await page.getByRole('button', { name: '新建内容', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建内容' });
    await labeled(dialog, '地址路径').fill('admin-browser-post');
    await labeled(dialog, '标题').fill('管理端真实内容');
    await labeled(dialog, '正文（Markdown）').fill('通过管理端保存并发布。');
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    const row = record(page, '管理端真实内容');
    await browserExpect(row).toBeVisible();
    await row.getByRole('button', { name: '发布已保存版本', exact: true }).click();
    await browserExpect(row.getByText('已发布', { exact: true })).toBeVisible();
    const publicResult = await request(f.app.getHttpServer())
      .get('/api/content/public/entry?kind=post&locale=zh&slug=admin-browser-post')
      .expect(200);
    expect(publicResult.body.title).toBe('管理端真实内容');
    await row.getByRole('button', { name: '取消发布', exact: true }).click();
    await browserExpect(row.getByText('草稿', { exact: true })).toBeVisible();
    await request(f.app.getHttpServer())
      .get('/api/content/public/entry?kind=post&locale=zh&slug=admin-browser-post')
      .expect(404);
    await page.screenshot({ path: artifact('admin-content.png'), fullPage: true, animations: 'disabled' });
  });
  it('retries an uncertain credit grant with the same key and gives the owner spendable lots once', async () => {
    await page.goto('/credit');
    await page.getByRole('button', { name: '发放积分', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '发放积分' });
    const fill = async () => {
      await labeled(dialog, '账户ID').fill(owner.userId);
      await labeled(dialog, '积分数量').fill('25');
      await labeled(dialog, '发放原因').fill('Synthetic browser support');
    };
    await fill();
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
      dialog.getByText('结果未确认；保持表单内容不变重试会复用同一请求编号'),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '发放积分', exact: true }).click();
    await fill();
    await dialog.getByRole('button', { name: '确认发放', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    await page.unroute('**/api/management/credits/*/grants');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    const result = await request(f.app.getHttpServer())
      .get(`/api/management/credits/${owner.userId}/balance`)
      .set('Authorization', `Bearer ${f.admin.token}`)
      .expect(200);
    expect(result.body.available).toBe(25);
    expect(await f.database.model('creditLots').count({ where: { userId: owner.userId } })).toBe(1);
    await record(page, owner.userId).first().getByRole('button', { name: '查看账户额度', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '账户额度' });
    await browserExpect(definition(drawer, '可用额度')).toHaveText('25');
    await page.screenshot({ path: artifact('admin-credits.png'), fullPage: true, animations: 'disabled' });
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  });
  it('persists only the actual site configuration and serves retired modules without requests', async () => {
    await page.goto('/config');
    await labeled(page, '网站名称').fill('管理端站点配置');
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
    // Tenant, i18n and notification-template pages were never backed by this server; fe-admin
    // does not register them, so direct URLs show "not found" and issue no module requests.
    const calls: string[] = [];
    const listener = (req: { url(): string }) => {
      if (/\/api\/(?:tenant|i18n|notification\/template)/.test(req.url())) calls.push(req.url());
    };
    page.on('request', listener);
    for (const path of ['/tenant', '/i18n', '/notification/template']) {
      await page.goto(path);
      await browserExpect(page.getByText('页面不存在', { exact: true })).toBeVisible();
    }
    page.off('request', listener);
    expect(calls).toEqual([]);
  });
  it('blocks unauthorized direct Admin routes and APIs without loading CMS data', async () => {
    const memberContext = await isolatedContext(browser, origin);
    try {
      const memberPage = await newPage(memberContext);
      await login(memberPage, 'browserowner', f.password);
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
    } finally {
      await memberContext.close();
    }
  });
  it('renders projected billing and runtime records without private fields on desktop and narrow screens', async () => {
    await seedManagementRecords(f, owner.userId);
    await page.goto('/records/orders');
    await browserExpect(visible(page.getByText('Synthetic safe offer', { exact: true })).first()).toBeVisible();
    await browserExpect(visible(page.getByText('10.00 USD', { exact: true })).first()).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE-');
    await record(page, 'projection-order-one').getByRole('button', { name: '详情', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '订单详情' });
    await browserExpect(definition(drawer, '金额')).toHaveText('10.00 USD');
    expect(await drawer.innerText()).not.toContain('PRIVATE-');
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await browserExpect(drawer).toHaveCount(0);
    await page.goto('/records/jobs');
    await browserExpect(visible(page.getByText('synthetic.task', { exact: true }))).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE-TASK');
    await page.goto('/records/deliveries');
    await browserExpect(visible(page.getByText('projection-delivery', { exact: true }))).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE-');
    await page.setViewportSize({ width: 390, height: 844 });
    const subscriptions = page.waitForResponse((response) =>
      response.url().includes('/api/management/billing-subscriptions'),
    );
    await page.goto('/records/subscriptions');
    expect((await subscriptions).status()).toBe(200);
    await browserExpect(visible(page.getByText('Synthetic safe offer', { exact: true }))).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE-');
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: artifact('admin-records-mobile.png'), fullPage: true, animations: 'disabled' });
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
    ], total: 2, page: 1, pageSize: 20 }) }));
    try {
      await page.goto('/credit');
      await record(page, owner.userId).first().getByRole('button', { name: '查看账户额度', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: '账户额度' });
      await browserExpect(definition(drawer, '可用额度')).toHaveText('20');
      await browserExpect(definition(drawer, '账面余额')).toHaveText('110');
      await browserExpect(definition(drawer, '保留额度')).toHaveText('30');
      await browserExpect(definition(drawer, '退款待处理额度')).toHaveText('60');
      const pending = drawer.locator('tbody tr').filter({ hasText: '退款待处理' });
      await browserExpect(pending).toHaveCount(1);
      await browserExpect(pending.getByRole('cell').nth(2)).toHaveText('0');
      await browserExpect(pending.getByRole('cell').nth(3)).toHaveText('20');
      await browserExpect(pending.getByRole('cell').nth(4)).toHaveText('60');
      await page.setViewportSize({ width: 390, height: 844 });
      await browserExpect.poll(async () => (await drawer.boundingBox())?.width ?? 1000).toBeLessThanOrEqual(390);
      await browserExpect(drawer.getByText('可用额度', { exact: true })).toBeInViewport();
      await browserExpect(drawer.getByText('这部分额度正在等待退款回收处理，不与保留额度重复计算。账面余额不是当前可消费额度。')).toBeVisible();
      await browserExpect.poll(() => noHorizontalOverflow(page)).toBe(true);
      await page.screenshot({ path: artifact('admin-refund-blocked-mobile.png'), fullPage: true });
      await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    } finally { await page.unroute(balancePath); await page.unroute(lotsPath); await page.setViewportSize({ width: 1440, height: 1000 }); }
  });
  it('shows read-only connection sources/missing fields and safe API key metadata', async () => {
    await page.goto('/connections');
    const stripe = record(page, /^Stripe/);
    await browserExpect(stripe.first()).toBeVisible();
    await browserExpect(visible(page.getByText('STRIPE_WEBHOOK_SECRET', { exact: true }))).toBeVisible();
    await browserExpect(
      visible(page.getByText('Server 环境配置（只读）', { exact: true })).first(),
    ).toBeVisible();
    await browserExpect(page.getByRole('textbox')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('SYNTHETIC-SECRET-NEVER-EXPOSE');
    await seedManagementApiKeys(f, owner.userId);
    await page.goto('/records/api-keys');
    await browserExpect(visible(page.getByText('Synthetic active key', { exact: true }))).toBeVisible();
    await browserExpect(visible(page.getByText('zk_api_active', { exact: true }))).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/PRIVATE-HASH|secretKey/);
    await browserExpect(page.getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
  });
});
