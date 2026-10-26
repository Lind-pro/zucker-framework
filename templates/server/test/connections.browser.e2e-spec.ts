import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import { connectionBrowserFixture } from './helpers/connection-browser-fixture';
import { AI_CONNECTIONS } from '../src/ai-connections/ai-connections.config';
import {
  ConnectionSettingsService,
  CONNECTION_SETTINGS_SCOPE,
} from '../src/runtime-settings/connection-settings.service';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_CONNECTIONS_BROWSER === '1'
    ? describe
    : describe.skip;
const origin = 'http://localhost:4323',
  replacementSecret = 'SYNTHETIC-BROWSER-REPLACED-SECRET';
run('real Admin connection settings browser and PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof connectionBrowserFixture>>,
    browser: Browser,
    page: Page,
    vite: ChildProcess;
  const responseBodies: Promise<string>[] = [];
  const get = (id = 'identity-google') =>
    request(f.app.getHttpServer())
      .get(`/api/management/connection-settings/${id}`)
      .set('Authorization', `Bearer ${f.admin.token}`);
  const put = (id: string, body: object) =>
    request(f.app.getHttpServer())
      .put(`/api/management/connection-settings/${id}`)
      .set('Authorization', `Bearer ${f.admin.token}`)
      .set('Origin', origin)
      .send(body);
  async function login(target: Page, username = 'connectionadmin') {
    await target.goto('/login');
    await target.getByPlaceholder('用户名', { exact: true }).fill(username);
    await target.getByPlaceholder('密码', { exact: true }).fill(f.password);
    await target.getByRole('button', { name: /登.*录/ }).click();
    await browserExpect(target).not.toHaveURL(/\/login$/);
    await target.goto('/connections');
    await browserExpect(target.getByRole('row').filter({ hasText: 'Google 登录' })).toBeVisible();
  }
  async function open(name = 'Google 登录', target = page) {
    await target
      .getByRole('row')
      .filter({ has: target.getByRole('cell', { name, exact: true }) })
      .getByRole('button', { name: /编辑配置|查看配置/ })
      .click();
    const dialog = target.getByRole('dialog');
    await browserExpect(dialog).toBeVisible();
    return dialog;
  }
  async function select(dialog: Locator, label: string, option: string, target = page) {
    await dialog.getByLabel(label, { exact: true }).press('ArrowDown');
    await target.locator('.ant-select-dropdown:visible').getByText(option, { exact: true }).click();
    await browserExpect(target.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  }
  async function edit(dialog: Locator, label: string, value: string, secret = false) {
    await select(dialog, `${label}操作`, secret ? '替换密钥' : '修改值');
    await dialog.getByLabel(`${label}新值`, { exact: true }).fill(value);
  }
  async function save(dialog: Locator) {
    await dialog.getByRole('button', { name: '加密保存', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
  }
  beforeAll(async () => {
    f = await connectionBrowserFixture(process.env.TEST_DATABASE_URL!, origin);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API is not listening');
    vite = spawn(
      'pnpm',
      ['exec', 'vite', '--host', 'localhost', '--port', '4323', '--strictPort'],
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
      await new Promise((resolve) => setTimeout(resolve, 250));
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
    page.on('response', (response) => {
      if (response.url().includes('/api/management/connection-settings'))
        responseBodies.push(response.text().catch(() => ''));
    });
    await login(page);
  }, 65_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({
        path: '/private/tmp/zucker-connections-browser-failure.png',
        fullPage: true,
        animations: 'disabled',
      });
      // Do not print form text: it can contain synthetic credentials and would normalize secret logging.
      console.info('Connection browser failure screenshot saved; URL:', page.url());
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
  it('renders every actual profile and server-described fields, including public integrations and storage', async () => {
    const profiles = (await f.settings.list()).profiles;
    const statuses = (
      await request(f.app.getHttpServer())
        .get('/api/management/connections')
        .set('Authorization', `Bearer ${f.admin.token}`)
        .expect(200)
    ).body.connections as Array<{ id: string; name: string }>;
    expect(profiles).toHaveLength(16);
    for (const profile of profiles) {
      const dialog = await open(
        statuses.find((row) => row.id === profile.id)?.name ?? profile.name,
      );
      for (const field of profile.fields)
        await browserExpect(
          dialog.getByLabel(`${field.label}操作`, { exact: true }),
        ).toBeAttached();
      await dialog.getByRole('button', { name: /取\s*消/ }).click();
    }
    expect((await Promise.all(responseBodies)).join('\n')).not.toContain(
      f.env.GOOGLE_CLIENT_SECRET,
    );
  });
  it('keeps, replaces and explicitly clears secrets without echo and persists encrypted revisions', async () => {
    let dialog = await open();
    await edit(dialog, 'Client ID', 'synthetic-client-one');
    await save(dialog);
    expect(
      (await new ConnectionSettingsService(f.database, f.env).environment()).GOOGLE_CLIENT_SECRET,
    ).toBe(f.env.GOOGLE_CLIENT_SECRET);
    dialog = await open();
    await edit(dialog, 'Client Secret', replacementSecret, true);
    await save(dialog);
    expect(
      (await new ConnectionSettingsService(f.database, f.env).environment()).GOOGLE_CLIENT_SECRET,
    ).toBe(replacementSecret);
    expect(
      await page.evaluate(
        (secret) =>
          [
            document.body.innerText,
            JSON.stringify(localStorage),
            JSON.stringify(sessionStorage),
          ].some((value) => value.includes(secret)),
        replacementSecret,
      ),
    ).toBe(false);
    dialog = await open();
    await browserExpect(dialog.getByText('已配置，值不会显示', { exact: true })).toBeVisible();
    await browserExpect(dialog.getByLabel('Client Secret新值', { exact: true })).toHaveCount(0);
    await edit(dialog, 'Client ID', 'synthetic-client-two');
    await save(dialog);
    expect(
      (await new ConnectionSettingsService(f.database, f.env).environment()).GOOGLE_CLIENT_SECRET,
    ).toBe(replacementSecret);
    dialog = await open();
    await select(dialog, 'Client Secret操作', '清除（屏蔽环境回退）');
    await save(dialog);
    const stored = (await get().expect(200)).body;
    expect(stored).toMatchObject({ storedRevision: 4, appliedRevision: 0, pendingRestart: true });
    expect(
      stored.fields.find((field: { key: string }) => field.key === 'GOOGLE_CLIENT_SECRET'),
    ).toMatchObject({ source: 'cleared', configured: false });
    expect(
      (await new ConnectionSettingsService(f.database, f.env).environment()).GOOGLE_CLIENT_SECRET,
    ).toBeUndefined();
    expect((await f.settings.environment()).GOOGLE_CLIENT_SECRET).toBe(f.env.GOOGLE_CLIENT_SECRET);
    const rows = (await f.database
      .model('config')
      .findMany({ where: { scope: CONNECTION_SETTINGS_SCOPE } })) as Array<{ value: unknown }>;
    const audit = await f.database
      .model('operationLogs')
      .findMany({ where: { module: 'runtime-settings' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toMatch(/^v2\./);
    expect(JSON.stringify([rows, audit, await Promise.all(responseBodies)])).not.toContain(
      replacementSecret,
    );
    await browserExpect(
      page.getByRole('row').filter({ hasText: 'Google 登录' }).getByText('运行 0 / 保存 4'),
    ).toBeVisible();
  });
  it('preserves non-secret drafts on real CAS conflict, clears entered secrets and explicitly rebases before retry', async () => {
    const dialog = await open();
    await edit(dialog, 'Client ID', 'synthetic-conflict-preserved-draft');
    await edit(dialog, 'Client Secret', 'SYNTHETIC-UNSAVED-CONFLICT-SECRET', true);
    await put('identity-google', {
      expectedRevision: 4,
      values: { GOOGLE_CLIENT_ID: 'synthetic-concurrent-writer' },
    }).expect(200);
    const conflictResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith('/identity-google'),
    );
    await dialog.getByRole('button', { name: '加密保存', exact: true }).click();
    expect((await conflictResponse).status()).toBe(409);
    await browserExpect(dialog.getByLabel('Client ID新值', { exact: true })).toHaveValue(
      'synthetic-conflict-preserved-draft',
    );
    await browserExpect(dialog.getByLabel('Client ID新值', { exact: true })).toBeDisabled();
    await browserExpect(dialog.getByLabel('Client Secret新值', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '重新读取配置', exact: true }).click();
    await browserExpect(dialog.getByLabel('Client ID新值', { exact: true })).toHaveValue(
      'synthetic-conflict-preserved-draft',
    );
    await browserExpect(dialog.getByLabel('Client ID新值', { exact: true })).toBeEnabled();
    await save(dialog);
    const stored = (await get().expect(200)).body;
    expect(stored.storedRevision).toBe(6);
    expect(
      (await new ConnectionSettingsService(f.database, f.env).environment()).GOOGLE_CLIENT_ID,
    ).toBe('synthetic-conflict-preserved-draft');
    expect(
      (await new ConnectionSettingsService(f.database, f.env).environment()).GOOGLE_CLIENT_SECRET,
    ).toBeUndefined();
  });
  it('reconstructs applied runtime state from PostgreSQL after a real HTTP application restart', async () => {
    expect((await f.settings.environment()).GOOGLE_CLIENT_ID).toBe('synthetic-google-environment');
    await f.restart();
    await page.reload();
    const row = page.getByRole('row').filter({ hasText: 'Google 登录' });
    await browserExpect(row.getByText('运行 6 / 保存 6')).toBeVisible();
    await browserExpect(row.getByText('待重启 Server', { exact: true })).toHaveCount(0);
    expect((await f.settings.environment()).GOOGLE_CLIENT_ID).toBe(
      'synthetic-conflict-preserved-draft',
    );
    expect((await f.settings.environment()).GOOGLE_CLIENT_SECRET).toBeUndefined();
  });
  it('uses query-only permissions in the actual account session and exposes no mutation controls', async () => {
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
    });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    const readerPage = await context.newPage();
    readerPage.setDefaultTimeout(7000);
    try {
      await login(readerPage, 'connectionreader');
      const dialog = await open('Google 登录', readerPage);
      await browserExpect(dialog.getByText('当前账户只有配置查看权限')).toBeVisible();
      await browserExpect(dialog.getByRole('button', { name: '加密保存' })).toHaveCount(0);
      await browserExpect(dialog.getByRole('combobox')).toHaveCount(0);
      await request(f.app.getHttpServer())
        .put('/api/management/connection-settings/identity-google')
        .set('Authorization', `Bearer ${f.reader.token}`)
        .set('Origin', origin)
        .send({ expectedRevision: 6, values: { GOOGLE_CLIENT_ID: 'forbidden-draft' } })
        .expect(403);
    } finally {
      await context.close();
    }
  });
  it('edits a server-described public profile at 390px without document overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const dialog = await open('网站分析');
    await edit(dialog, 'GA4 Measurement ID', 'G-SYNTHETIC');
    await save(dialog);
    await browserExpect(
      page.getByRole('row').filter({ hasText: '网站分析' }).getByText('运行 0 / 保存 1'),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const mobileDialog = await open('网站分析');
    const box = await mobileDialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(390);
    await mobileDialog
      .getByText('编辑连接配置 · 网站分析', { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: '/private/tmp/zucker-connections-mobile-20261024.png',
      animations: 'disabled',
    });
    await mobileDialog.getByRole('button', { name: /取\s*消/ }).click();
  });
  it('renders six optional native AI profiles and saves the compatible connection through the real encrypted API', async () => {
    for (const definition of AI_CONNECTIONS) {
      const row = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: definition.name, exact: true }) });
      await browserExpect(row.getByText('未启用', { exact: true })).toBeVisible();
      const dialog = await open(definition.name);
      for (const label of [
        '启用',
        'API 密钥',
        '模型 ID',
        'API 地址',
        '最大输出 Token',
        '超时（毫秒）',
      ])
        await browserExpect(dialog.getByLabel(`${label}操作`, { exact: true })).toBeAttached();
      await dialog.getByRole('button', { name: /取\s*消/ }).click();
    }
    const dialog = await open('OpenAI 兼容接口');
    await select(dialog, '启用操作', '修改值');
    await select(dialog, '启用新值', '启用');
    await edit(dialog, 'API 密钥', 'SYNTHETIC-BROWSER-NATIVE-AI-KEY', true);
    await edit(dialog, '模型 ID', 'synthetic-compatible-model');
    await edit(dialog, 'API 地址', 'https://compatible.example.invalid/v1');
    await edit(dialog, '最大输出 Token', '256');
    await edit(dialog, '超时（毫秒）', '3500');
    await save(dialog);
    await browserExpect(
      page.getByRole('row').filter({ hasText: 'OpenAI 兼容接口' }).getByText('运行 0 / 保存 1'),
    ).toBeVisible();
    const result = (await get('ai-compatible').expect(200)).body;
    expect(result).toMatchObject({ storedRevision: 1, appliedRevision: 0, pendingRestart: true });
    expect(
      result.fields.find((field: { key: string }) => field.key === 'AI_COMPATIBLE_API_KEY'),
    ).not.toHaveProperty('value');
    expect(
      await page.evaluate(
        (secret) =>
          [
            document.body.innerText,
            JSON.stringify(localStorage),
            JSON.stringify(sessionStorage),
          ].some((value) => value.includes(secret)),
        'SYNTHETIC-BROWSER-NATIVE-AI-KEY',
      ),
    ).toBe(false);
  });
  it('shows a real missing-encryption-key startup as read-only and does not pretend saves are available', async () => {
    await f.restart({ clearSavedProfiles: true, withoutEncryptionKey: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    const dialog = await open();
    await browserExpect(dialog.getByText('尚未配置独立的配置加密密钥，当前只能查看')).toBeVisible();
    await browserExpect(dialog.getByRole('button', { name: '加密保存' })).toHaveCount(0);
    await browserExpect(dialog.getByRole('combobox')).toHaveCount(0);
    expect((await get().expect(200)).body).toMatchObject({
      canSave: false,
      storedRevision: 0,
      appliedRevision: 0,
    });
  });
});
