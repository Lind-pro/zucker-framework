import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { formEngineFixture } from './helpers/form-engine-fixture';
const run = process.env.TEST_DATABASE_URL && process.env.RUN_FORM_ENGINE_BROWSER === '1' ? describe : describe.skip;
const origin = 'http://localhost:4330', screenshots = '/private/tmp/zucker-form-engine-browser-20261024';
run('default Admin form create/edit and failed-save recovery in an actual browser', () => {
  let f: Awaited<ReturnType<typeof formEngineFixture>>, browser: Browser, page: Page, vite: ChildProcess, savedId = '';
  beforeAll(async () => {
    f = await formEngineFixture(process.env.TEST_DATABASE_URL!, origin); const address = f.app.getHttpServer().address(); if (!address || typeof address === 'string') throw new Error('API is not listening');
    // rc-util intentionally reuses a fixed accessibility ID under NODE_ENV=test.
    vite = spawn(resolve('../admin/node_modules/.bin/vite'), ['--host', 'localhost', '--port', '4330', '--strictPort'], { cwd: resolve('../admin'), env: { ...process.env, NODE_ENV: 'development', API_PROXY_TARGET: `http://127.0.0.1:${address.port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [vite.stdout, vite.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-3000); });
    const deadline = Date.now() + 45000; let ready = false;
    while (Date.now() < deadline) {
      if (vite.exitCode !== null) throw new Error(`Admin startup failed: ${output}`);
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(1500) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`Admin startup timed out: ${output}`);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1100 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    page = await context.newPage(); page.on('pageerror', error => console.info('Form page runtime error:', error.message)); page.on('response', response => { if (response.url().includes('/api/authorize/') && response.status() >= 400) console.info('Form account HTTP failure:', new URL(response.url()).pathname, response.status()); }); page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(15000);
    await page.goto('/login'); await page.getByPlaceholder('用户名', { exact: true }).fill('formsadmin'); await page.getByPlaceholder('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: /登\s*录/ }).click(); await browserExpect(page).toHaveURL(/\/dashboard$/); await page.goto('/form-engine');
    mkdirSync(screenshots, { recursive: true });
  }, 65000);
  afterEach(async context => { if (context.task.result?.state === 'fail' && page) { await page.screenshot({ path: `${screenshots}/failure-diagnostic.png`, fullPage: true, animations: 'disabled' }); console.info('Form failure view:', page.url(), (await page.locator('body').innerText()).slice(0, 3000), await page.locator('body').ariaSnapshot()); } });
  afterAll(async () => { await browser?.close(); if (vite && vite.exitCode === null) { vite.kill('SIGTERM'); await Promise.race([new Promise(resolve => vite.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]); } await f?.close(); });
  it('creates an empty definition, edits one real field, retains failed edits and saves them after database recovery', async () => {
    await page.getByRole('button', { name: /新建表单/ }).click(); const create = page.getByRole('dialog', { name: '新建表单定义', exact: true });
    await create.getByLabel('表单名称', { exact: true }).fill('Synthetic browser form');
    const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/form/definition') && response.request().method() === 'POST');
    await create.locator('.ant-modal-footer button').last().click(); const response = await createdResponse; expect(response.status()).toBe(201); const record = await response.json(); savedId = record.id; expect(record.fields).toEqual([]);
    await browserExpect(create).not.toBeVisible(); const row = page.getByRole('row').filter({ hasText: 'Synthetic browser form' }); await row.getByRole('button', { name: /编\s*辑/ }).click();
    const drawer = page.getByRole('dialog', { name: '编辑表单定义', exact: true }); await drawer.getByRole('button', { name: /添加字段/ }).click();
    const field = page.getByRole('dialog', { name: '新建字段', exact: true }); await field.getByLabel(/字段标识/).fill('contact'); await field.getByLabel(/显示名/).fill('Contact name');
    await field.getByLabel(/类型/).click(); await page.getByText('文本 (STRING)', { exact: true }).last().click(); await field.locator('.ant-modal-footer button').last().click(); await browserExpect(field).not.toBeVisible();
    await drawer.getByLabel(/表单名称/).fill('Retained edit after failure');
    await f.withFailedUpdate(async () => {
      const failed = page.waitForResponse(response => response.url().endsWith(`/api/form/definition/${savedId}`) && response.request().method() === 'PUT');
      await drawer.getByRole('button', { name: /^保\s*存$/ }).click(); expect((await failed).status()).toBe(500);
      await browserExpect(drawer.getByText('保存失败，编辑内容已保留，请重试保存', { exact: true })).toBeVisible();
      await browserExpect(drawer.getByLabel(/表单名称/)).toHaveValue('Retained edit after failure'); await browserExpect(drawer.getByText('Contact name', { exact: true })).toBeVisible();
      const stored = await f.database.model('formDefinition').findUnique({ where: { id: savedId } }) as { name: string; fields: unknown[] }; expect(stored).toMatchObject({ name: 'Synthetic browser form', fields: [] });
      await page.screenshot({ path: `${screenshots}/save-failure-preserved.png`, fullPage: true, animations: 'disabled' });
    });
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/form/definition/${savedId}`) && response.request().method() === 'PUT'); await drawer.getByRole('button', { name: /^保\s*存$/ }).click(); expect((await saved).status()).toBe(200);
    await browserExpect(drawer).not.toBeVisible(); await page.reload(); await browserExpect(page.getByRole('row').filter({ hasText: 'Retained edit after failure' })).toBeVisible();
    expect(await f.database.model('formDefinition').findUnique({ where: { id: savedId } })).toMatchObject({ name: 'Retained edit after failure', version: 2, fields: [{ key: 'contact', name: 'Contact name', type: 'string' }] });
  });
  it('uses English field types and preview text and persists another edit without changing its field identity', async () => {
    await page.getByRole('combobox', { name: 'Language / 语言' }).press('ArrowDown'); await page.getByText('English', { exact: true }).last().click();
    const row = page.getByRole('row').filter({ hasText: 'Retained edit after failure' }); await row.getByRole('button', { name: /Edit$/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Edit form definition', exact: true }); await drawer.getByLabel(/Form name/).fill('English saved form');
    await drawer.getByRole('button', { name: /Add field$/ }).click(); const field = page.getByRole('dialog', { name: 'Create field', exact: true });
    await field.getByLabel(/Type/).click(); await browserExpect(page.getByText('Text (STRING)', { exact: true }).last()).toBeVisible();
    await page.keyboard.press('Escape'); await field.locator('.ant-modal-footer button').first().click();
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/form/definition/${savedId}`) && response.request().method() === 'PUT'); await drawer.getByRole('button', { name: 'Save', exact: true }).click(); expect((await saved).status()).toBe(200); await browserExpect(drawer).not.toBeVisible();
    expect(await f.database.model('formDefinition').findUnique({ where: { id: savedId } })).toMatchObject({ name: 'English saved form', version: 3, fields: [{ key: 'contact', name: 'Contact name', type: 'string' }] });
    const previewFields = [{ key: 'contact', name: '客户名称', type: 'string', required: true }, { key: 'metadata', name: 'Metadata', type: 'json' }, { key: 'state', name: 'Approval', type: 'enum', options: [{ label: 'Approved', value: 'approved' }] }];
    const previewUpdate = await page.request.put(`/api/form/definition/${savedId}`, { headers: { Authorization: `Bearer ${f.admin.token}` }, data: { fields: previewFields } }); expect(previewUpdate.status()).toBe(200);
    await page.reload(); const updated = page.getByRole('row').filter({ hasText: 'English saved form' }); await updated.getByRole('button', { name: /Preview$/ }).click();
    const preview = page.getByRole('dialog', { name: 'Preview: English saved form', exact: true }); await browserExpect(preview).toBeVisible();
    await browserExpect(preview.getByText('Please select', { exact: true })).toBeVisible(); await browserExpect(preview.getByLabel(/客户名称/)).toBeVisible();
    await preview.getByLabel('Metadata', { exact: true }).fill('{invalid'); await preview.getByRole('button', { name: 'Preview submission', exact: true }).click();
    await browserExpect(preview.getByText('This field is required', { exact: true })).toBeVisible(); await browserExpect(preview.getByText('Enter valid JSON', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${screenshots}/english-preview.png`, fullPage: true, animations: 'disabled' });
  });
});
