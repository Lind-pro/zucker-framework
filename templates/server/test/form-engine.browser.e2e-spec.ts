import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { formEngineFixture } from './helpers/form-engine-fixture';
import { artifact, isolatedContext, launchBrowser, newPage, record, startAdmin, type AdminServer } from './helpers/fe-admin-browser';
import { loginAs, warmUp } from './helpers/admin-locale-browser';

const run = process.env.TEST_DATABASE_URL && process.env.RUN_FORM_ENGINE_BROWSER === '1' ? describe : describe.skip;
const port = 4330;

run('default Admin form create/edit and failed-save recovery in an actual browser', () => {
  let f: Awaited<ReturnType<typeof formEngineFixture>>, admin: AdminServer, browser: Browser, page: Page, savedId = '';
  const pageErrors: string[] = [];
  const definitionPut = (response: { url(): string; request(): { method(): string } }) =>
    response.url().endsWith(`/api/form/definition/${savedId}`) && response.request().method() === 'PUT';
  beforeAll(async () => {
    f = await formEngineFixture(process.env.TEST_DATABASE_URL!, `http://localhost:${port}`);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API is not listening');
    admin = await startAdmin(port, address.port);
    browser = await launchBrowser();
    page = await newPage(await isolatedContext(browser, admin.origin, { width: 1440, height: 1100 }));
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await warmUp(page);
    await loginAs(page, 'formsadmin', f.password);
    await page.goto('/form-engine');
  }, 65_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({ path: artifact('form-engine-failure.png'), fullPage: true, animations: 'disabled' });
      console.info('Form failure view:', page.url(), (await page.locator('body').ariaSnapshot()).slice(0, 4000));
    }
  });
  afterAll(async () => {
    await browser?.close();
    await admin?.stop();
    await f?.close();
  });

  it('creates an empty definition, edits one real field, retains failed edits and saves them after database recovery', async () => {
    await page.getByRole('button', { name: '新建表单', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建表单定义', exact: true });
    await create.getByRole('textbox', { name: '表单名称', exact: true }).fill('Synthetic browser form');
    const createdResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/form/definition') && response.request().method() === 'POST',
    );
    await create.getByRole('button', { name: '保存', exact: true }).click();
    const response = await createdResponse;
    expect(response.status()).toBe(201);
    const created = await response.json();
    savedId = created.id;
    expect(created.fields).toEqual([]);
    await browserExpect(create).toHaveCount(0);

    await record(page, 'Synthetic browser form').getByRole('button', { name: '编辑', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '编辑表单定义', exact: true });
    await drawer.getByRole('button', { name: '添加字段', exact: true }).click();
    const field = page.getByRole('dialog', { name: '新建字段', exact: true });
    await field.getByRole('textbox', { name: '字段标识', exact: true }).fill('contact');
    await field.getByRole('textbox', { name: '显示名', exact: true }).fill('Contact name');
    await field.getByRole('combobox', { name: '类型', exact: true }).selectOption('string');
    await field.getByRole('button', { name: '保存', exact: true }).click();
    await browserExpect(field).toHaveCount(0);
    await drawer.getByRole('textbox', { name: '表单名称', exact: true }).fill('Retained edit after failure');

    await f.withFailedUpdate(async () => {
      const failed = page.waitForResponse(definitionPut);
      await drawer.getByRole('button', { name: '保存', exact: true }).click();
      expect((await failed).status()).toBe(500);
      await browserExpect(drawer.getByText('保存失败，编辑内容已保留，请重试保存', { exact: true })).toBeVisible();
      await browserExpect(drawer.getByRole('textbox', { name: '表单名称', exact: true })).toHaveValue('Retained edit after failure');
      await browserExpect(drawer.getByRole('cell', { name: 'Contact name', exact: true })).toBeVisible();
      const stored = (await f.database.model('formDefinition').findUnique({ where: { id: savedId } })) as {
        name: string;
        fields: unknown[];
      };
      expect(stored).toMatchObject({ name: 'Synthetic browser form', fields: [] });
      await page.screenshot({ path: artifact('form-engine-save-failure-preserved.png'), fullPage: true, animations: 'disabled' });
    });

    const saved = page.waitForResponse(definitionPut);
    await drawer.getByRole('button', { name: '保存', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await browserExpect(drawer).toHaveCount(0);
    await page.reload();
    await browserExpect(record(page, 'Retained edit after failure')).toBeVisible();
    expect(await f.database.model('formDefinition').findUnique({ where: { id: savedId } })).toMatchObject({
      name: 'Retained edit after failure',
      version: 2,
      fields: [{ key: 'contact', name: 'Contact name', type: 'string' }],
    });
  });

  it('uses English copy and persists another edit without changing its field identity, then previews stored fields', async () => {
    await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en-US');
    await browserExpect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await record(page, 'Retained edit after failure').getByRole('button', { name: 'Edit', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Edit form definition', exact: true });
    await drawer.getByRole('textbox', { name: 'Form name', exact: true }).fill('English saved form');
    await drawer.getByRole('button', { name: 'Add field', exact: true }).click();
    const field = page.getByRole('dialog', { name: 'New field', exact: true });
    await browserExpect(field.getByRole('combobox', { name: 'Type', exact: true }).locator('option[value="string"]')).toHaveCount(1);
    await browserExpect(field.getByRole('textbox', { name: 'Key', exact: true })).toBeEnabled();
    // Cancelling the field editor must not add a field to the draft.
    await field.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(field).toHaveCount(0);
    const saved = page.waitForResponse(definitionPut);
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await browserExpect(drawer).toHaveCount(0);
    expect(await f.database.model('formDefinition').findUnique({ where: { id: savedId } })).toMatchObject({
      name: 'English saved form',
      version: 3,
      fields: [{ key: 'contact', name: 'Contact name', type: 'string' }],
    });

    const previewFields = [
      { key: 'contact', name: '客户名称', type: 'string', required: true },
      { key: 'metadata', name: 'Metadata', type: 'json' },
      { key: 'state', name: 'Approval', type: 'enum', options: [{ label: 'Approved', value: 'approved' }] },
    ];
    const previewUpdate = await page.request.put(`/api/form/definition/${savedId}`, {
      headers: { Authorization: `Bearer ${f.admin.token}` },
      data: { fields: previewFields },
    });
    expect(previewUpdate.status()).toBe(200);
    await page.reload();
    await record(page, 'English saved form').getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Preview: English saved form', exact: true });
    await browserExpect(preview).toBeVisible();
    await browserExpect(preview.getByText('Preview only; nothing is submitted', { exact: true })).toBeVisible();
    await browserExpect(preview.getByRole('textbox', { name: '客户名称', exact: true })).toBeVisible();
    await browserExpect(preview.getByRole('textbox', { name: 'Metadata', exact: true })).toBeVisible();
    const approval = preview.getByRole('combobox', { name: 'Approval', exact: true });
    await browserExpect(approval.locator('option')).toHaveText(['Select', 'Approved']);
    await preview.getByRole('textbox', { name: 'Metadata', exact: true }).fill('{invalid');
    await page.screenshot({ path: artifact('form-engine-english-preview.png'), fullPage: true, animations: 'disabled' });
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    await browserExpect(preview).toHaveCount(0);
    // The preview never submits: the stored definition is unchanged.
    expect(await f.database.model('formDefinition').findUnique({ where: { id: savedId } })).toMatchObject({ version: 4, fields: previewFields });
    expect(pageErrors).toEqual([]);
  });
});
