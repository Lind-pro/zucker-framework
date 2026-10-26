import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import { managementFixture } from './helpers/management-fixture';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_USER_ROLES_BROWSER === '1'
    ? describe
    : describe.skip;
const origin = 'http://localhost:4327';
interface Role {
  id: string;
  name: string;
}
run('actual Admin user-role assignment with PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>,
    browser: Browser,
    page: Page,
    vite: ChildProcess;
  let alice: { userId: string; token: string },
    bob: { userId: string; token: string },
    reader: { userId: string; token: string },
    noCatalog: { userId: string; token: string };
  let first: Role, second: Role, third: Role, far: Role;
  const put = (id: string, roleIds: string[], token = f.admin.token) =>
    request(f.app.getHttpServer())
      .put(`/api/users/${id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleIds });
  const ids = async (id: string) =>
    (
      (
        await request(f.app.getHttpServer())
          .get(`/api/users/${id}/roles`)
          .set('Authorization', `Bearer ${f.admin.token}`)
          .expect(200)
      ).body.roleIds as string[]
    ).sort();
  async function login(target: Page, username = 'manageadmin') {
    await target.goto('/login');
    await target.getByPlaceholder('Username', { exact: true }).fill(username);
    await target.getByPlaceholder('Password', { exact: true }).fill(f.password);
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browserExpect(target).not.toHaveURL(/\/login$/);
    await target.goto('/users');
    await browserExpect(target.getByRole('row').filter({ hasText: 'assignalice' })).toBeVisible();
  }
  async function open(username: string, label = 'Assign roles') {
    await page
      .getByRole('row')
      .filter({ hasText: username })
      .getByText(label, { exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog).toBeVisible();
    return dialog;
  }
  async function context() {
    const value = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
    });
    await value.addInitScript(() => localStorage.setItem('zucker-admin-locale', 'en'));
    await value.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    return value;
  }
  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!, origin);
    alice = await f.member('assignalice');
    bob = await f.member('assignbob');
    reader = await f.member('assignreader', ['users:query', 'roles:query']);
    noCatalog = await f.member('assignnocatalog', ['users:query', 'users:authorize']);
    for (let index = 0; index < 26; index++)
      await f.database.model('roles').create({
        data: {
          id: `assign-role-${String(index).padStart(2, '0')}`,
          name: `Synthetic role ${String(index).padStart(2, '0')}`,
        },
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
    vite = spawn(
      resolve('../admin/node_modules/.bin/vite'),
      ['--host', 'localhost', '--port', '4327', '--strictPort'],
      {
        cwd: resolve('../admin'),
        env: {
          ...process.env,
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
      await new Promise((done) => setTimeout(done, 250));
    }
    if (!ready) throw new Error(`Admin startup exceeded 45 seconds: ${output}`);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ownerContext = await context();
    page = await ownerContext.newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(15000);
    await login(page);
  }, 65_000);
  beforeEach(async () => {
    await put(alice.userId, [far.id]).expect(200);
    await put(bob.userId, [second.id]).expect(200);
    await page.goto('/users');
  });
  afterEach(async (state) => {
    if (state.task.result?.state === 'fail')
      await page.screenshot({
        path: '/private/tmp/zucker-user-roles-failure.png',
        fullPage: true,
        animations: 'disabled',
      });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
  afterAll(async () => {
    await browser?.close();
    if (vite && vite.exitCode === null) {
      vite.kill('SIGTERM');
      await Promise.race([
        new Promise((done) => vite.once('exit', done)),
        new Promise((done) => setTimeout(done, 2500)),
      ]);
    }
    await f?.close();
  });
  it('grants and revokes real memberships while preserving selections on another role page', async () => {
    let dialog = await open('assignalice');
    await browserExpect(
      dialog.getByRole('button', { name: 'Save roles', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('checkbox', { name: first.name, exact: true }).check();
    await dialog.getByTitle('2', { exact: true }).click();
    await browserExpect(
      dialog.getByRole('checkbox', { name: far.name, exact: true }),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Save roles', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await ids(alice.userId)).toEqual([first.id, far.id].sort());
    dialog = await open('assignalice');
    await dialog.getByRole('button', { name: `Remove role ${far.name}`, exact: true }).click();
    await dialog.getByRole('button', { name: 'Save roles', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await ids(alice.userId)).toEqual([first.id]);
    dialog = await open('assignalice');
    await dialog.getByRole('button', { name: `Remove role ${first.name}`, exact: true }).click();
    await dialog.getByRole('button', { name: 'Save roles', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await ids(alice.userId)).toEqual([]);
  });
  it('blocks saving after read failures and retains drafts through catalog and write retries', async () => {
    const target = `**/api/users/${bob.userId}/roles`;
    await page.route(target, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Synthetic role read failure' }),
      }),
    );
    const dialog = await open('assignbob');
    await browserExpect(
      dialog.getByText('Current roles could not be loaded. Saving is disabled.'),
    ).toBeVisible();
    await browserExpect(
      dialog.getByRole('button', { name: 'Save roles', exact: true }),
    ).toBeDisabled();
    await page.unroute(target);
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(
      dialog.getByRole('checkbox', { name: second.name, exact: true }),
    ).toBeChecked();
    await dialog.getByRole('checkbox', { name: first.name, exact: true }).check();
    await page.route('**/api/roles/_query', (route) =>
      route.request().postDataJSON().pageIndex === 1
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Synthetic catalog failure' }),
          })
        : route.continue(),
    );
    await dialog.getByTitle('2', { exact: true }).click();
    await browserExpect(
      dialog.getByText('Could not load roles. Your selections are kept.'),
    ).toBeVisible();
    await browserExpect(
      dialog.getByRole('button', { name: 'Save roles', exact: true }),
    ).toBeDisabled();
    await browserExpect(dialog.getByRole('region', { name: 'Selected roles' })).toContainText(
      first.name,
    );
    await page.unroute('**/api/roles/_query');
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(
      dialog.getByRole('checkbox', { name: far.name, exact: true }),
    ).toBeVisible();
    await page.route(target, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Synthetic role write failure' }),
          })
        : route.continue(),
    );
    await dialog.getByRole('button', { name: 'Save roles', exact: true }).click();
    await browserExpect(
      dialog.getByText('Role save was not confirmed. Your draft is kept.'),
    ).toBeVisible();
    expect(await ids(bob.userId)).toEqual([second.id]);
    await browserExpect(dialog.getByRole('region', { name: 'Selected roles' })).toContainText(
      first.name,
    );
    await page.unroute(target);
    await dialog.getByRole('button', { name: /Save roles$/ }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await ids(bob.userId)).toEqual([first.id, second.id].sort());
  });
  it('isolates users from unsaved changes and late detail responses', async () => {
    let dialog = await open('assignalice');
    await dialog.getByRole('checkbox', { name: third.name, exact: true }).check();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    dialog = await open('assignbob');
    await browserExpect(
      dialog.getByRole('checkbox', { name: second.name, exact: true }),
    ).toBeChecked();
    await browserExpect(
      dialog.getByRole('checkbox', { name: third.name, exact: true }),
    ).not.toBeChecked();
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
        /* The closed target may cancel its request. */
      }
    });
    try {
      const started = page.waitForRequest((req) =>
        req.url().endsWith(`/users/${alice.userId}/roles`),
      );
      dialog = await open('assignalice');
      await started;
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      dialog = await open('assignbob');
      await browserExpect(
        dialog.getByRole('checkbox', { name: second.name, exact: true }),
      ).toBeChecked();
      release();
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      await browserExpect(dialog.getByRole('region', { name: 'Selected roles' })).toContainText(
        second.name,
      );
      await browserExpect(dialog.getByRole('region', { name: 'Selected roles' })).not.toContainText(
        far.name,
      );
      await browserExpect(
        dialog.getByRole('button', { name: 'Save roles', exact: true }),
      ).toBeDisabled();
      expect(await ids(alice.userId)).toEqual([far.id]);
      expect(await ids(bob.userId)).toEqual([second.id]);
    } finally {
      release();
      await page.unroute(path);
    }
  });
  it('requires both permissions and keeps the Chinese editor usable at 390px', async () => {
    for (const username of ['assignreader', 'assignnocatalog']) {
      const limitedContext = await context();
      const limitedPage = await limitedContext.newPage();
      let roleReads = 0;
      limitedPage.on('request', (req) => {
        if (
          req.url().includes('/api/roles/_query') ||
          /\/api\/users\/[^/]+\/roles$/.test(req.url())
        )
          roleReads++;
      });
      try {
        await login(limitedPage, username);
        await browserExpect(limitedPage.getByText('Assign roles', { exact: true })).toHaveCount(0);
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
    await page.getByRole('combobox', { name: 'Language / 语言', exact: true }).press('ArrowDown');
    await page.locator('.ant-select-dropdown:visible').getByText('中文', { exact: true }).click();
    await browserExpect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await open('assignalice', '分配角色');
    await browserExpect(
      dialog.getByText('保存将替换此用户的完整角色列表', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      dialog.getByRole('checkbox', { name: first.name, exact: true }),
    ).toBeVisible();
    await browserExpect
      .poll(async () => (await dialog.boundingBox())?.width ?? 1000)
      .toBeLessThanOrEqual(390);
    await browserExpect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
      .toBe(true);
    await page.screenshot({
      path: '/private/tmp/zucker-user-roles-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
  });
});
