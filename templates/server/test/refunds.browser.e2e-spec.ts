import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { managementFixture } from './helpers/management-fixture';
import { refundBrowserProviders } from './helpers/refund-browser-providers';
import { readCreditBalance } from '../src/credits/credits.service';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_REFUNDS_BROWSER === '1'
    ? describe
    : describe.skip;
const origin = 'http://localhost:4322';
run('real Admin refund browser with PostgreSQL cash and hold facts', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>,
    providers: ReturnType<typeof refundBrowserProviders>,
    browser: Browser,
    page: Page,
    vite: ChildProcess,
    counter = 0;
  async function purchase(mode: 'payment' | 'subscription' = 'payment') {
    const owner = await f.member(`refundui${++counter}`);
    const post = (path: string, body: object) =>
      request(f.app.getHttpServer())
        .post(`/api/billing/${path}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .set('Origin', origin)
        .send(body);
    const created = await post('orders', {
      offerId: mode === 'payment' ? 'credits' : 'subscription',
      providerId: 'stripe',
    })
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const result = providers.paid(created.body.id);
    await post(`orders/${result.orderId}/confirm`, {}).expect(200);
    expect((await readCreditBalance(f.database, owner.userId)).available).toBe(100);
    return { ...result, owner };
  }
  async function login(target = page, username = 'manageadmin') {
    await target.goto('/login');
    await target.getByPlaceholder('用户名', { exact: true }).fill(username);
    await target.getByPlaceholder('密码', { exact: true }).fill(f.password);
    await target.getByRole('button', { name: /登.*录/ }).click();
    await browserExpect(target).toHaveURL(/\/dashboard$/);
  }
  async function openForm(orderId: string, amount = '2.00', reason = 'Synthetic UI refund') {
    await page.goto(`/refunds?targetType=order&targetId=${orderId}`);
    await page.getByRole('button', { name: '申请退款', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认退款申请' });
    await dialog.getByLabel('退款金额（USD）', { exact: true }).fill(amount);
    await dialog.getByLabel('退款原因（可选）', { exact: true }).fill(reason);
    return dialog;
  }
  beforeAll(async () => {
    providers = refundBrowserProviders(origin);
    f = await managementFixture(process.env.TEST_DATABASE_URL!, origin, providers.options);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    vite = spawn(
      'pnpm',
      ['exec', 'vite', '--host', 'localhost', '--port', '4322', '--strictPort'],
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
        path: '/tmp/zucker-refunds-failure.png',
        fullPage: true,
        animations: 'disabled',
      });
      console.info(
        'Refund UI failure:',
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
  it('does not dispatch on viewing/canceling/checking, then shows pending cash and reserved credits before settlement', async () => {
    const order = await purchase(),
      before = providers.calls.length;
    let dialog = await openForm(order.orderId);
    expect(providers.calls.length).toBe(before);
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    await page.getByRole('button', { name: '核对渠道记录', exact: true }).click();
    await browserExpect(page.getByText('渠道退款事实已核对', { exact: true })).toBeVisible();
    expect(providers.calls.length).toBe(before);
    dialog = await openForm(order.orderId);
    await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    const details = page.getByRole('dialog', { name: '退款详情' });
    await browserExpect(details.getByText('额度已保留', { exact: true })).toBeVisible();
    expect(await readCreditBalance(f.database, order.ownerId)).toMatchObject({
      available: 80,
      frozen: 20,
    });
    expect(providers.calls.length).toBe(before + 1);
    providers.settle(order.paymentId);
    await details.getByRole('button', { name: '核对退款状态', exact: true }).click();
    await browserExpect(details.getByText('额度处理完成', { exact: true })).toBeVisible();
    expect(await readCreditBalance(f.database, order.ownerId)).toMatchObject({
      available: 80,
      frozen: 0,
    });
    expect(providers.calls.length).toBe(before + 1);
    await browserExpect(page.getByText('查看现有退款', { exact: true })).toHaveCount(0);
    await browserExpect(page.getByRole('button', { name: '申请退款', exact: true })).toBeEnabled();
    await page.screenshot({
      path: '/tmp/zucker-refunds-settled.png',
      fullPage: true,
      animations: 'disabled',
    });
  });
  it('recovers a lost HTTP acknowledgement by its actor-bound key without sending a second refund command', async () => {
    const order = await purchase(),
      before = providers.calls.length,
      dialog = await openForm(order.orderId, '3', 'Response lost recovery');
    let postCount = 0,
      recovered = 0;
    await page.route('**/api/billing/refunds', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      postCount++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 503, message: 'Synthetic response loss after commit' }),
      });
    });
    page.on('request', (req) => {
      if (req.url().includes('/api/billing/refunds/requests/')) recovered++;
    });
    await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
    await browserExpect(
      page.getByText('结果未确认。请保持申请内容不变重试，或先查看退款记录。'),
    ).toBeVisible();
    await page.unroute('**/api/billing/refunds');
    await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
    await browserExpect(page.getByText('已恢复上次申请，没有再次发起退款。')).toBeVisible();
    expect(postCount).toBe(1);
    expect(recovered).toBeGreaterThan(0);
    expect(providers.calls.length).toBe(before + 1);
  });
  it('resumes only a prepared request with the original key after refresh and a real database dispatch-claim failure', async () => {
    const order = await purchase(),
      before = providers.calls.length;
    await f.pool.query(
      `CREATE FUNCTION "${f.schema}".reject_refund_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='submitting' THEN RAISE EXCEPTION 'Synthetic dispatch claim failure'; END IF; RETURN NEW; END $$`,
    );
    await f.pool.query(
      `CREATE TRIGGER reject_refund_dispatch BEFORE UPDATE ON "${f.schema}".billing_refund_requests FOR EACH ROW EXECUTE FUNCTION "${f.schema}".reject_refund_dispatch()`,
    );
    try {
      const dialog = await openForm(order.orderId, '2', 'Prepared recovery');
      await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
      await browserExpect(
        page.getByText('结果未确认。请保持申请内容不变重试，或先查看退款记录。'),
      ).toBeVisible();
      expect(providers.calls.length).toBe(before);
    } finally {
      await f.pool.query(
        `DROP TRIGGER reject_refund_dispatch ON "${f.schema}".billing_refund_requests`,
      );
      await f.pool.query(`DROP FUNCTION "${f.schema}".reject_refund_dispatch()`);
    }
    await page.reload();
    await page.getByRole('button', { name: '查看现有退款', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认退款申请' });
    await browserExpect(dialog).toBeVisible();
    await browserExpect(dialog.getByLabel('退款金额（USD）', { exact: true })).toHaveValue('2.00');
    await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(providers.calls.length).toBe(before + 1);
  });
  it('preserves succeeded cash and attention on a credit settlement failure, then checks without redispatch', async () => {
    const order = await purchase(),
      before = providers.calls.length;
    providers.modes.set(order.paymentId, 'succeeded');
    await f.pool.query(
      `CREATE FUNCTION "${f.schema}".reject_refund_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='CONFIRMED' THEN RAISE EXCEPTION 'Synthetic hold settle failure'; END IF; RETURN NEW; END $$`,
    );
    await f.pool.query(
      `CREATE TRIGGER reject_refund_settlement BEFORE UPDATE ON "${f.schema}".credit_holds FOR EACH ROW EXECUTE FUNCTION "${f.schema}".reject_refund_settlement()`,
    );
    try {
      const dialog = await openForm(order.orderId, '10.00', 'Credit attention');
      await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
      await browserExpect(
        page.getByText('结果未确认。请保持申请内容不变重试，或先查看退款记录。'),
      ).toBeVisible();
    } finally {
      await f.pool.query(`DROP TRIGGER reject_refund_settlement ON "${f.schema}".credit_holds`);
      await f.pool.query(`DROP FUNCTION "${f.schema}".reject_refund_settlement()`);
    }
    await page.reload();
    await page.getByRole('button', { name: '查看现有退款', exact: true }).click();
    const details = page.getByRole('dialog', { name: '退款详情' });
    await browserExpect(details.getByText('额度处理需要人工核对', { exact: true })).toBeVisible();
    await browserExpect(details.getByText('已完成', { exact: true })).toBeVisible();
    expect(providers.calls.length).toBe(before + 1);
    await details.getByRole('button', { name: '核对退款状态', exact: true }).click();
    await browserExpect(details.getByText('额度处理完成', { exact: true })).toBeVisible();
    expect(providers.calls.length).toBe(before + 1);
    expect(await readCreditBalance(f.database, order.ownerId)).toMatchObject({
      available: 0,
      frozen: 0,
    });
  });
  it('marks unapplied cash evidence as pending and requires checking before another refund', async () => {
    const order = await purchase(), before = providers.calls.length;
    const target = `**/api/billing/refunds/targets/order/${order.orderId}`;
    await page.route(target, async route => {
      const response = await route.fetch(), body = await response.json();
      await route.fulfill({ response, json: { ...body, cashEvidencePending: true, attention: true, capabilities: { ...body.capabilities, canCreate: false } } });
    });
    try {
      await page.goto(`/refunds?targetType=order&targetId=${order.orderId}`);
      await browserExpect(page.getByText('现金证明待核对，金额尚未更新', { exact: true })).toBeVisible();
      await browserExpect(page.getByText('上次已核对退款', { exact: true })).toBeVisible();
      await browserExpect(page.getByText('上次已核对可退金额', { exact: true })).toBeVisible();
      await browserExpect(page.getByRole('button', { name: '申请退款', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: '核对渠道记录', exact: true }).click();
      await browserExpect(page.getByText('现金证明待核对，金额尚未更新', { exact: true })).toHaveCount(0);
      await browserExpect(page.getByRole('button', { name: '申请退款', exact: true })).toBeEnabled();
      expect(providers.calls.length).toBe(before);
    } finally { await page.unroute(target); }
  });
  it('uses only returned local subscription cycle IDs and blocks unauthorized Admin/API access', async () => {
    const order = await purchase('subscription'),
      before = providers.calls.length;
    await page.goto(`/refunds?subscriptionId=${order.orderId}`);
    await page.getByRole('button', { name: '查看退款概况', exact: true }).click();
    await browserExpect(page).toHaveURL(/targetType=cycle/);
    await browserExpect(page.getByText('付款周期退款概况', { exact: true })).toBeVisible();
    expect(providers.calls.length).toBe(before);
    const context = await browser.newContext({ baseURL: origin });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    const userPage = await context.newPage();
    userPage.setDefaultTimeout(7000);
    await login(userPage, `refundui${counter}`);
    await userPage.goto('/refunds');
    await browserExpect(userPage.getByText('没有访问权限', { exact: true })).toBeVisible();
    await request(f.app.getHttpServer())
      .get('/api/billing/refunds')
      .set('Authorization', `Bearer ${order.owner.token}`)
      .expect(403);
    await context.close();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/refunds');
    await browserExpect(
      page.getByRole('columnheader', { name: '整体状态', exact: true }),
    ).toBeVisible();
    await browserExpect(page.locator('.ant-spin-spinning')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(
      true,
    );
    await page.screenshot({
      path: '/tmp/zucker-refunds-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
  });
});
