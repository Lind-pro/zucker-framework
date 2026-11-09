import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expect as browserExpect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import request from 'supertest';
import { managementFixture } from './helpers/management-fixture';
import { artifact, isolatedContext, launchBrowser, newPage, record, startAdmin, type AdminServer } from './helpers/fe-admin-browser';
import { loginAs, presetLocale, warmUp } from './helpers/admin-locale-browser';

const run = process.env.TEST_DATABASE_URL && process.env.RUN_ROLES_BROWSER === '1' ? describe : describe.skip;
const port = 4326;

run('actual Admin role drafts and protected grants with PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>, admin: AdminServer, browser: Browser, page: Page;
  let roleA: { id: string; name: string }, roleB: { id: string; name: string }, limited: { token: string; userId: string };
  const pageErrors: string[] = [];
  const alpha = 'synthetic-grant:alpha',
    beta = 'synthetic-grant:beta';
  const saveFailed = /The save was not confirmed/;
  async function grants(id: string) {
    return (
      (await f.database.model('rolePermissions').findMany({ where: { roleId: id }, select: { permissionId: true } })) as Array<{
        permissionId: string;
      }>
    )
      .map((row) => row.permissionId)
      .sort();
  }
  async function englishContext(): Promise<BrowserContext> {
    const context = await isolatedContext(browser, admin.origin);
    await presetLocale(context, 'en-US');
    return context;
  }
  async function signIn(target: Page, username = 'manageadmin') {
    await loginAs(target, username, f.password, 'en-US');
    await target.goto('/roles');
    await browserExpect(record(target, roleA.name)).toBeVisible();
  }
  async function open(role: { name: string }, target = page) {
    await record(target, role.name).getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = target.getByRole('dialog', { name: 'Edit role', exact: true });
    await browserExpect(dialog.getByRole('textbox', { name: 'Role name', exact: true })).toHaveValue(role.name);
    return dialog;
  }
  /** One permission checkbox in the grant catalog (its label is "<name> <code>"). */
  const grant = (dialog: Locator, name: string) => dialog.getByRole('checkbox', { name: new RegExp(`^${name}\\b`) });
  const editGrants = (dialog: Locator) => dialog.getByRole('checkbox', { name: 'Edit role grants', exact: true });
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!, `http://localhost:${port}`);
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
    await f.database.model('rolePermissions').create({ data: { roleId: roleA.id, permissionId: alpha } });
    await f.database.model('rolePermissions').create({ data: { roleId: roleB.id, permissionId: beta } });
    limited = await f.member('roleeditor', ['roles:query', 'roles:update']);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    admin = await startAdmin(port, address.port);
    browser = await launchBrowser();
    page = await newPage(await englishContext());
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await warmUp(page);
    await signIn(page);
  }, 65_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({ path: artifact('roles-failure.png'), fullPage: true, animations: 'disabled' });
      console.info('Roles failure view:', page.url(), (await page.locator('body').ariaSnapshot()).slice(0, 4000));
    }
  });
  beforeEach(async () => {
    await page.unrouteAll({ behavior: 'wait' });
    await page.goto('/roles');
    // Let the cookie-refresh session restore settle before any further navigation.
    await browserExpect(record(page, roleA.name)).toBeVisible();
  });
  afterAll(async () => {
    await browser?.close();
    await admin?.stop();
    await f?.close();
  });

  it('uses the actual role details and omits grants when a description-only update is saved', async () => {
    const dialog = await open(roleA);
    await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Description-only browser update');
    const sent = page.waitForRequest((req) => req.method() === 'PUT' && req.url().endsWith(`/roles/${roleA.id}`));
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
    const context = await englishContext();
    const target = await newPage(context);
    try {
      await signIn(target, 'roleeditor');
      const dialog = await open(roleA, target);
      await browserExpect(dialog.getByRole('textbox', { name: 'Role name', exact: true })).toBeDisabled();
      await browserExpect(dialog.getByText('Changing a role name requires authorization-management access.')).toBeVisible();
      await browserExpect(editGrants(dialog)).toHaveCount(0);
      await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Limited editor browser update');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      expect(await f.database.model('roles').findUnique({ where: { id: roleA.id } })).toMatchObject({
        name: roleA.name,
        description: 'Limited editor browser update',
      });
      expect(await grants(roleA.id)).toEqual([alpha]);
    } finally {
      await context.close();
    }
  });

  it('isolates role drafts and submits permission changes only after explicit grant editing', async () => {
    let dialog = await open(roleA);
    await editGrants(dialog).check();
    await browserExpect(grant(dialog, 'Synthetic Alpha grant')).toBeChecked();
    await grant(dialog, 'Synthetic Beta grant').check();
    await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Unsaved alpha draft');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    dialog = await open(roleB);
    await browserExpect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Initial beta description');
    await browserExpect(editGrants(dialog)).not.toBeChecked();
    await editGrants(dialog).check();
    await browserExpect(grant(dialog, 'Synthetic Beta grant')).toBeChecked();
    await browserExpect(grant(dialog, 'Synthetic Alpha grant')).not.toBeChecked();
    await grant(dialog, 'Synthetic Alpha grant').check();
    const sent = page.waitForRequest((req) => req.method() === 'PUT' && req.url().endsWith(`/roles/${roleB.id}`));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    // Only the explicitly edited grants are sent; untouched metadata is not.
    expect((await sent).postDataJSON()).toEqual({ permissionIds: [alpha, beta] });
    await browserExpect(dialog).toHaveCount(0);
    expect(await grants(roleA.id)).toEqual([alpha]);
    expect(await grants(roleB.id)).toEqual([alpha, beta]);
    expect(await f.database.model('roles').findUnique({ where: { id: roleA.id } })).not.toMatchObject({ description: 'Unsaved alpha draft' });
  });

  it('disables writes on failed details or grant catalog reads and retains the draft after a failed save', async () => {
    await page.route(`**/api/roles/${roleA.id}`, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 503, body: '{}' }) : route.continue(),
    );
    await record(page, roleA.name).getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit role', exact: true });
    await browserExpect(dialog.getByText(/Could not load role details/)).toBeVisible();
    await browserExpect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.unroute(`**/api/roles/${roleA.id}`);
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(dialog.getByRole('textbox', { name: 'Role name', exact: true })).toHaveValue(roleA.name);

    await page.route('**/api/permissions/tree', (route) => route.fulfill({ status: 503, body: '{}' }));
    await editGrants(dialog).check();
    await browserExpect(dialog.getByText('Could not load the permission catalog')).toBeVisible();
    await browserExpect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.unroute('**/api/permissions/tree');
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(grant(dialog, 'Synthetic Alpha grant')).toBeChecked();
    await editGrants(dialog).uncheck();
    await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Retry keeps this description');

    await page.route(`**/api/roles/${roleA.id}`, (route) =>
      route.request().method() === 'PUT' ? route.fulfill({ status: 503, body: '{}' }) : route.continue(),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(page.getByText(saveFailed)).toBeVisible();
    await browserExpect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Retry keeps this description');
    expect(await grants(roleA.id)).toEqual([alpha]);
    await page.unroute(`**/api/roles/${roleA.id}`);
    const sent = page.waitForRequest((req) => req.method() === 'PUT' && req.url().endsWith(`/roles/${roleA.id}`));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await sent).postDataJSON()).toEqual({ description: 'Retry keeps this description' });
    await browserExpect(dialog).toHaveCount(0);
    expect(await grants(roleA.id)).toEqual([alpha]);
  });

  it('creates a real role without a nonexistent code field', async () => {
    await page.getByRole('button', { name: 'Create role', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create role', exact: true });
    await dialog.getByRole('textbox', { name: 'Role name', exact: true }).fill('Synthetic browser-created role');
    await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Created through actual API');
    const sent = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/api/roles'));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await sent).postDataJSON()).toEqual({ name: 'Synthetic browser-created role', description: 'Created through actual API' });
    await browserExpect(dialog).toHaveCount(0);
    expect(await f.database.model('roles').findUnique({ where: { name: 'Synthetic browser-created role' } })).toMatchObject({
      description: 'Created through actual API',
    });
    await browserExpect(record(page, 'Synthetic browser-created role')).toBeVisible();
  });

  it('creates and edits real permission identifiers, preserves grants and retains a rejected draft for retry', async () => {
    await page.goto('/permissions');
    await page.getByRole('button', { name: 'Create permission', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Create permission', exact: true });
    await dialog.getByRole('textbox', { name: 'Permission name', exact: true }).fill('Synthetic new permission');
    await dialog.getByRole('textbox', { name: 'Permission code', exact: true }).fill(alpha);
    await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Retained after duplicate identifier');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog.getByText(saveFailed)).toBeVisible();
    await browserExpect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Retained after duplicate identifier');
    expect(await f.database.model('permissions').findUnique({ where: { id: alpha } })).toMatchObject({ name: 'Synthetic Alpha grant' });
    const id = 'synthetic-browser:new';
    await dialog.getByRole('textbox', { name: 'Permission code', exact: true }).fill(id);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await f.database.model('permissions').findUnique({ where: { id } })).toMatchObject({
      name: 'Synthetic new permission',
      description: 'Retained after duplicate identifier',
    });
    await f.database.model('rolePermissions').create({ data: { roleId: roleA.id, permissionId: id } });
    // Lists are paged in the database in a stable id order; find the record through the code filter.
    await page.getByRole('textbox', { name: 'Permission code', exact: true }).first().fill('synthetic-browser');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await record(page, id).getByRole('button', { name: 'Edit', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Edit permission', exact: true });
    await browserExpect(dialog.getByRole('textbox', { name: 'Permission code', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Permission name', exact: true }).fill('Synthetic renamed permission');
    const sent = page.waitForRequest((req) => req.method() === 'PUT' && decodeURIComponent(req.url()).endsWith(`/permissions/${id}`));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await sent).postDataJSON()).toEqual({
      name: 'Synthetic renamed permission',
      description: 'Retained after duplicate identifier',
    });
    await browserExpect(dialog).toHaveCount(0);
    expect(await grants(roleA.id)).toContain(id);
    expect(pageErrors).toEqual([]);
  });
});
