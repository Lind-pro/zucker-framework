import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expect as browserExpect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import request from 'supertest';
import { managementFixture } from './helpers/management-fixture';
import { artifact, isolatedContext, launchBrowser, newPage, noHorizontalOverflow, record, startAdmin, type AdminServer } from './helpers/fe-admin-browser';
import { loginAs, presetLocale, switchLanguage, warmUp } from './helpers/admin-locale-browser';

const run = process.env.TEST_DATABASE_URL && process.env.RUN_USER_ROLES_BROWSER === '1' ? describe : describe.skip;
const port = 4328;
interface Role {
  id: string;
  name: string;
}

run('actual Admin user-role assignment with PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>, admin: AdminServer, browser: Browser, page: Page;
  let alice: { userId: string; token: string },
    bob: { userId: string; token: string },
    reader: { userId: string; token: string },
    noCatalog: { userId: string; token: string };
  let first: Role, second: Role, third: Role, far: Role;
  const pageErrors: string[] = [];
  const put = (id: string, roleIds: string[], token = f.admin.token) =>
    request(f.app.getHttpServer()).put(`/api/users/${id}/roles`).set('Authorization', `Bearer ${token}`).send({ roleIds });
  const ids = async (id: string) =>
    (
      (await request(f.app.getHttpServer()).get(`/api/users/${id}/roles`).set('Authorization', `Bearer ${f.admin.token}`).expect(200)).body
        .roleIds as string[]
    ).sort();
  async function signIn(target: Page, username = 'manageadmin') {
    await loginAs(target, username, f.password, 'en-US');
    await target.goto('/users');
    await browserExpect(record(target, 'assignalice')).toBeVisible();
  }
  async function open(username: string, label = 'Assign roles', title = `Assign roles to ${username}`) {
    await record(page, username).getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await browserExpect(dialog).toBeVisible();
    return dialog;
  }
  const roleBox = (dialog: ReturnType<Page['getByRole']>, role: Role) => dialog.getByRole('checkbox', { name: role.name, exact: true });
  const selectedRegion = (dialog: ReturnType<Page['getByRole']>) => dialog.getByRole('region', { name: /^Selected roles \(\d+\)$/ });
  const saveButton = (dialog: ReturnType<Page['getByRole']>) => dialog.getByRole('button', { name: 'Save roles', exact: true });
  async function englishContext(): Promise<BrowserContext> {
    const context = await isolatedContext(browser, admin.origin);
    await presetLocale(context, 'en-US');
    return context;
  }
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!, `http://localhost:${port}`);
    alice = await f.member('assignalice');
    bob = await f.member('assignbob');
    reader = await f.member('assignreader', ['users:query', 'roles:query']);
    noCatalog = await f.member('assignnocatalog', ['users:query', 'users:authorize']);
    for (let index = 0; index < 26; index++)
      await f.database.model('roles').create({
        data: { id: `assign-role-${String(index).padStart(2, '0')}`, name: `Synthetic role ${String(index).padStart(2, '0')}` },
      });
    const query = (pageIndex: number) =>
      request(f.app.getHttpServer())
        .post('/api/roles/_query')
        .set('Authorization', `Bearer ${f.admin.token}`)
        .send({ pageIndex, pageSize: 20 });
    const firstPage = (await query(0).expect(200)).body.data as Role[],
      secondPage = (await query(1).expect(200)).body.data as Role[];
    [first, second, third] = firstPage.filter((row) => row.id.startsWith('assign-role-'));
    far = secondPage.find((row) => row.id.startsWith('assign-role-'))!;
    if (!first || !second || !third || !far) throw new Error('Missing paginated role fixture');
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    admin = await startAdmin(port, address.port);
    browser = await launchBrowser();
    page = await newPage(await englishContext());
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await warmUp(page);
    await signIn(page);
  }, 65_000);
  beforeEach(async () => {
    await put(alice.userId, [far.id]).expect(200);
    await put(bob.userId, [second.id]).expect(200);
    await page.goto('/users');
    // Let the cookie-refresh session restore settle before interacting.
    await browserExpect(record(page, 'assignalice')).toBeVisible();
  });
  afterEach(async (state) => {
    if (state.task.result?.state === 'fail') {
      await page.screenshot({ path: artifact('user-roles-failure.png'), fullPage: true, animations: 'disabled' });
      console.info('User roles failure view:', page.url(), (await page.locator('body').ariaSnapshot()).slice(0, 4000));
    }
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
  afterAll(async () => {
    await browser?.close();
    await admin?.stop();
    await f?.close();
  });

  it('grants and revokes real memberships while preserving selections on another role page', async () => {
    let dialog = await open('assignalice');
    await browserExpect(saveButton(dialog)).toBeDisabled();
    await roleBox(dialog, first).check();
    await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
    await browserExpect(roleBox(dialog, far)).toBeChecked();
    await browserExpect(selectedRegion(dialog)).toContainText(first.name);
    await saveButton(dialog).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await ids(alice.userId)).toEqual([first.id, far.id].sort());
    dialog = await open('assignalice');
    await dialog.getByRole('button', { name: `Remove role ${far.name}`, exact: true }).click();
    await saveButton(dialog).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await ids(alice.userId)).toEqual([first.id]);
    dialog = await open('assignalice');
    await dialog.getByRole('button', { name: `Remove role ${first.name}`, exact: true }).click();
    await browserExpect(dialog.getByText('No roles selected', { exact: true })).toBeVisible();
    await saveButton(dialog).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await ids(alice.userId)).toEqual([]);
  });

  it('blocks saving after read failures and retains drafts through catalog and write retries', async () => {
    const target = `**/api/users/${bob.userId}/roles`;
    await page.route(target, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic role read failure' }) }),
    );
    const dialog = await open('assignbob');
    await browserExpect(dialog.getByText('Current roles could not be loaded. Saving is disabled.')).toBeVisible();
    await browserExpect(saveButton(dialog)).toBeDisabled();
    await page.unroute(target);
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(roleBox(dialog, second)).toBeChecked();
    await roleBox(dialog, first).check();
    await page.route('**/api/roles/_query', (route) =>
      route.request().postDataJSON().pageIndex === 1
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic catalog failure' }) })
        : route.continue(),
    );
    await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
    await browserExpect(dialog.getByText('Could not load roles. Your selections are kept.')).toBeVisible();
    await browserExpect(saveButton(dialog)).toBeDisabled();
    await browserExpect(selectedRegion(dialog)).toContainText(first.name);
    await page.unroute('**/api/roles/_query');
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(roleBox(dialog, far)).toBeVisible();
    await page.route(target, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic role write failure' }) })
        : route.continue(),
    );
    await saveButton(dialog).click();
    await browserExpect(dialog.getByText(/The role save was not confirmed; your draft is kept/)).toBeVisible();
    expect(await ids(bob.userId)).toEqual([second.id]);
    await browserExpect(selectedRegion(dialog)).toContainText(first.name);
    await page.unroute(target);
    await saveButton(dialog).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await ids(bob.userId)).toEqual([first.id, second.id].sort());
  });

  it('isolates users from unsaved changes and late detail responses', async () => {
    let dialog = await open('assignalice');
    await roleBox(dialog, third).check();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    dialog = await open('assignbob');
    await browserExpect(roleBox(dialog, second)).toBeChecked();
    await browserExpect(roleBox(dialog, third)).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const path = `**/api/users/${alice.userId}/roles`;
    await page.route(path, async (route) => {
      const response = await route.fetch();
      await held;
      try {
        await route.fulfill({ response });
      } catch {
        /* The closed editor may cancel its request. */
      }
    });
    try {
      const started = page.waitForRequest((req) => req.url().endsWith(`/users/${alice.userId}/roles`));
      dialog = await open('assignalice');
      await started;
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      dialog = await open('assignbob');
      await browserExpect(roleBox(dialog, second)).toBeChecked();
      release();
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await browserExpect(selectedRegion(dialog)).toContainText(second.name);
      await browserExpect(selectedRegion(dialog)).not.toContainText(far.name);
      await browserExpect(saveButton(dialog)).toBeDisabled();
      expect(await ids(alice.userId)).toEqual([far.id]);
      expect(await ids(bob.userId)).toEqual([second.id]);
    } finally {
      release();
      await page.unroute(path);
    }
  });

  it('requires both permissions and keeps the Chinese editor usable at 390px', async () => {
    for (const username of ['assignreader', 'assignnocatalog']) {
      const limitedContext = await englishContext();
      const limitedPage = await newPage(limitedContext);
      let roleReads = 0;
      limitedPage.on('request', (req) => {
        if (req.url().includes('/api/roles/_query') || /\/api\/users\/[^/]+\/roles$/.test(req.url())) roleReads++;
      });
      try {
        await signIn(limitedPage, username);
        await browserExpect(limitedPage.getByRole('button', { name: 'Assign roles', exact: true })).toHaveCount(0);
        expect(roleReads).toBe(0);
      } finally {
        await limitedContext.close();
      }
    }
    await put(alice.userId, [first.id], reader.token).expect(403);
    await request(f.app.getHttpServer())
      .post('/api/roles/_query')
      .set('Authorization', `Bearer ${noCatalog.token}`)
      .send({ pageIndex: 0, pageSize: 20 })
      .expect(403);
    expect(await ids(alice.userId)).toEqual([far.id]);

    await switchLanguage(page, 'zh-CN');
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await open('assignalice', '分配角色', '为 assignalice 分配角色');
    await browserExpect(dialog.getByText('保存将替换此用户的完整角色列表', { exact: true })).toBeVisible();
    await browserExpect(roleBox(dialog, first)).toBeVisible();
    await browserExpect.poll(async () => (await dialog.boundingBox())?.width ?? 1000).toBeLessThanOrEqual(390);
    await browserExpect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: artifact('user-roles-mobile.png'), fullPage: true, animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await switchLanguage(page, 'en-US');
    expect(pageErrors).toEqual([]);
  });
});
