import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type Page,
  type Locator,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import { managementFixture } from './helpers/management-fixture';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_ROLES_BROWSER === '1' ? describe : describe.skip;
const origin = 'http://localhost:4326';
run('actual Admin role drafts and protected grants with PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>,
    browser: Browser,
    page: Page,
    vite: ChildProcess;
  let roleA: { id: string; name: string },
    roleB: { id: string; name: string },
    limited: { token: string; userId: string };
  const alpha = 'synthetic-grant:alpha',
    beta = 'synthetic-grant:beta';
  async function grants(id: string) {
    return (
      (await f.database
        .model('rolePermissions')
        .findMany({ where: { roleId: id }, select: { permissionId: true } })) as Array<{
        permissionId: string;
      }>
    )
      .map((row) => row.permissionId)
      .sort();
  }
  async function login(target: Page, username = 'manageadmin') {
    await target.goto('/login');
    await target.getByPlaceholder('Username', { exact: true }).fill(username);
    await target.getByPlaceholder('Password', { exact: true }).fill(f.password);
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browserExpect(target).not.toHaveURL(/\/login$/);
    await target.goto('/roles');
    await browserExpect(target.getByRole('row').filter({ hasText: roleA.name })).toBeVisible();
  }
  async function open(role: { name: string }, target = page) {
    await target
      .getByRole('row')
      .filter({ hasText: role.name })
      .getByText('Edit', { exact: true })
      .click();
    const dialog = target.getByRole('dialog');
    await browserExpect(dialog.getByLabel('Role name', { exact: true })).toHaveValue(role.name);
    return dialog;
  }
  const check = (dialog: Locator, name: string) =>
    dialog.locator('.ant-tree-treenode').filter({ hasText: name }).locator('.ant-tree-checkbox');
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!, origin);
    for (const [id, name] of [
      [alpha, 'Synthetic Alpha grant'],
      [beta, 'Synthetic Beta grant'],
    ])
      await f.database.model('permissions').create({ data: { id, name, actions: [] } });
    roleA = (await f.database.model('roles').create({
      data: { name: 'Synthetic Role Alpha', description: 'Initial alpha description' },
    })) as typeof roleA;
    roleB = (await f.database.model('roles').create({
      data: { name: 'Synthetic Role Beta', description: 'Initial beta description' },
    })) as typeof roleB;
    await f.database
      .model('rolePermissions')
      .create({ data: { roleId: roleA.id, permissionId: alpha } });
    await f.database
      .model('rolePermissions')
      .create({ data: { roleId: roleB.id, permissionId: beta } });
    limited = await f.member('roleeditor', ['roles:query', 'roles:update']);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    vite = spawn(
      'pnpm',
      ['exec', 'vite', '--host', 'localhost', '--port', '4326', '--strictPort'],
      {
        cwd: resolve('../admin'),
        env: {
          ...process.env,
          pnpm_config_verify_deps_before_run: 'false',
          NODE_ENV: 'development',
          API_PROXY_TARGET: `http://127.0.0.1:${address.port}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    for (const stream of [vite.stdout, vite.stderr])
      stream?.on('data', (chunk) => {
        output = (output + String(chunk)).slice(-2000);
      });
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      if (vite.exitCode !== null) throw new Error(`Admin stopped: ${output}`);
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
    await context.addInitScript(() => localStorage.setItem('zucker-admin-locale', 'en'));
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    await login(page);
  }, 65000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page)
      await page.screenshot({
        path: '/private/tmp/zucker-role-browser-failure.png',
        fullPage: true,
        animations: 'disabled',
      });
  });
  beforeEach(async () => {
    await page.unrouteAll({ behavior: 'wait' });
    await page.goto('/roles');
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
  it('uses the actual role details and omits grants when a description-only update is saved', async () => {
    const dialog = await open(roleA);
    await dialog.getByLabel('Description', { exact: true }).fill('Description-only browser update');
    const sent = page.waitForRequest(
      (request) => request.method() === 'PUT' && request.url().endsWith(`/roles/${roleA.id}`),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await sent).postDataJSON()).toEqual({ description: 'Description-only browser update' });
    await browserExpect(dialog).toHaveCount(0);
    expect(await grants(roleA.id)).toEqual([alpha]);
  });
  it('allows a roles:update editor to save a description without requiring roles:authorize', async () => {
    await request(f.app.getHttpServer())
      .put(`/api/roles/${roleA.id}`)
      .set('Authorization', `Bearer ${limited.token}`)
      .send({ description: 'HTTP limited editor' })
      .expect(200);
    expect(await grants(roleA.id)).toEqual([alpha]);
    const context = await browser.newContext({ baseURL: origin });
    await context.addInitScript(() => localStorage.setItem('zucker-admin-locale', 'en'));
    const target = await context.newPage();
    target.setDefaultTimeout(8000);
    try {
      await login(target, 'roleeditor');
      const dialog = await open(roleA, target);
      await browserExpect(dialog.getByLabel('Role name', { exact: true })).toBeDisabled();
      await browserExpect(dialog.getByText('Edit role grants', { exact: true })).toHaveCount(0);
      await dialog.getByLabel('Description', { exact: true }).fill('Limited editor browser update');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      expect(await grants(roleA.id)).toEqual([alpha]);
    } finally {
      await context.close();
    }
  });
  it('isolates role drafts and submits permission changes only after explicit grant editing', async () => {
    let dialog = await open(roleA);
    await dialog.getByRole('checkbox', { name: 'Edit role grants' }).check();
    await browserExpect(check(dialog, 'Synthetic Alpha grant')).toHaveClass(
      /ant-tree-checkbox-checked/,
    );
    await check(dialog, 'Synthetic Beta grant').click();
    await dialog.getByLabel('Description', { exact: true }).fill('Unsaved alpha draft');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    dialog = await open(roleB);
    await browserExpect(dialog.getByLabel('Description', { exact: true })).toHaveValue(
      'Initial beta description',
    );
    await dialog.getByRole('checkbox', { name: 'Edit role grants' }).check();
    await browserExpect(check(dialog, 'Synthetic Beta grant')).toHaveClass(
      /ant-tree-checkbox-checked/,
    );
    await browserExpect(check(dialog, 'Synthetic Alpha grant')).not.toHaveClass(
      /ant-tree-checkbox-checked/,
    );
    await check(dialog, 'Synthetic Alpha grant').click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await grants(roleA.id)).toEqual([alpha]);
    expect(await grants(roleB.id)).toEqual([alpha, beta]);
  });
  it('disables writes on failed details or grant catalog reads and retains the draft after a failed save', async () => {
    await page.route(`**/api/roles/${roleA.id}`, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 503, body: '{}' })
        : route.continue(),
    );
    await page
      .getByRole('row')
      .filter({ hasText: roleA.name })
      .getByText('Edit', { exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByText('Could not load role details')).toBeVisible();
    await browserExpect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.unroute(`**/api/roles/${roleA.id}`);
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(dialog.getByLabel('Role name', { exact: true })).toHaveValue(roleA.name);
    await page.route('**/api/permissions/tree', (route) =>
      route.fulfill({ status: 503, body: '{}' }),
    );
    await dialog.getByRole('checkbox', { name: 'Edit role grants' }).check();
    await browserExpect(dialog.getByText('Could not load the permission catalog')).toBeVisible();
    await browserExpect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.unroute('**/api/permissions/tree');
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(check(dialog, 'Synthetic Alpha grant')).toHaveClass(
      /ant-tree-checkbox-checked/,
    );
    await dialog.getByRole('checkbox', { name: 'Edit role grants' }).uncheck();
    await dialog.getByLabel('Description', { exact: true }).fill('Retry keeps this description');
    await page.route(`**/api/roles/${roleA.id}`, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 503, body: '{}' })
        : route.continue(),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(page.getByText(/Role save was not confirmed/)).toBeVisible();
    await browserExpect(dialog.getByLabel('Description', { exact: true })).toHaveValue(
      'Retry keeps this description',
    );
    expect(await grants(roleA.id)).toEqual([alpha]);
    await page.unroute(`**/api/roles/${roleA.id}`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await grants(roleA.id)).toEqual([alpha]);
  });
  it('creates a real role without the removed nonexistent code field', async () => {
    await page.getByRole('button', { name: /Create role$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Role name', { exact: true }).fill('Synthetic browser-created role');
    await dialog.getByLabel('Description', { exact: true }).fill('Created through actual API');
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/roles'),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await sent).postDataJSON()).toEqual({
      name: 'Synthetic browser-created role',
      description: 'Created through actual API',
    });
    await browserExpect(dialog).toHaveCount(0);
    expect(
      await f.database
        .model('roles')
        .findUnique({ where: { name: 'Synthetic browser-created role' } }),
    ).toMatchObject({ description: 'Created through actual API' });
  });
  it('creates and edits real permission identifiers, preserves grants and retains a rejected draft for retry', async () => {
    await page.goto('/permissions');
    await page.getByRole('button', { name: /Create permission$/ }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Permission name', { exact: true }).fill('Synthetic new permission');
    await dialog.getByLabel('Permission code', { exact: true }).fill(alpha);
    await dialog
      .getByLabel('Description', { exact: true })
      .fill('Retained after duplicate identifier');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(page.getByText(/Permission save was not confirmed/)).toBeVisible();
    await browserExpect(dialog.getByLabel('Description', { exact: true })).toHaveValue(
      'Retained after duplicate identifier',
    );
    const id = 'synthetic-browser:new';
    await dialog.getByLabel('Permission code', { exact: true }).fill(id);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await f.database.model('permissions').findUnique({ where: { id } })).toMatchObject({
      name: 'Synthetic new permission',
      description: 'Retained after duplicate identifier',
    });
    await f.database
      .model('rolePermissions')
      .create({ data: { roleId: roleA.id, permissionId: id } });
    await page.getByRole('row').filter({ hasText: id }).getByText('Edit', { exact: true }).click();
    dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByLabel('Permission code', { exact: true })).toBeDisabled();
    await dialog
      .getByLabel('Permission name', { exact: true })
      .fill('Synthetic renamed permission');
    const sent = page.waitForRequest(
      (request) =>
        request.method() === 'PUT' &&
        decodeURIComponent(request.url()).endsWith(`/permissions/${id}`),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await sent).postDataJSON()).toEqual({
      name: 'Synthetic renamed permission',
      description: 'Retained after duplicate identifier',
    });
    await browserExpect(dialog).toHaveCount(0);
    expect(await grants(roleA.id)).toContain(id);
  });
});
