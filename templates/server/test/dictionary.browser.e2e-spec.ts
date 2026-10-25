import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type Page,
  type Locator,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { dictionaryFixture } from './helpers/dictionary-fixture';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_DICTIONARY_BROWSER === '1'
    ? describe
    : describe.skip;
const origin = 'http://localhost:4331';
run('actual Admin dictionary CRUD and scoped items with PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof dictionaryFixture>>,
    browser: Browser,
    page: Page,
    vite: ChildProcess;
  let first: { id: string; name: string }, second: { id: string; name: string }, firstItem: string;
  const dictionaries = () => page.getByLabel('Dictionaries', { exact: true });
  const items = () => page.getByLabel('Dictionary items', { exact: true });
  async function save(dialog: Locator) {
    await browserExpect(dialog.getByRole('button', { name: /OK$/ })).not.toHaveClass(
      /ant-btn-loading/,
    );
    await dialog.getByRole('button', { name: /OK$/ }).click();
    await browserExpect(dialog).toHaveCount(0);
  }
  async function select(name: string) {
    await dictionaries()
      .getByRole('row')
      .filter({ hasText: name })
      .getByText('View items', { exact: true })
      .click();
  }
  async function createType(name: string, classified: string) {
    await dictionaries()
      .getByRole('button', { name: /Create$/ })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Dictionary name', { exact: true }).fill(name);
    await dialog.getByLabel('Category code', { exact: true }).fill(classified);
    await save(dialog);
    const rows = (await f.database.model('dictionary').findMany({ where: { name } })) as Array<{
      id: string;
      name: string;
    }>;
    expect(rows).toHaveLength(1);
    return rows[0];
  }
  async function createItem(text: string, value: string, ordinal: number) {
    await items()
      .getByRole('button', { name: /Create$/ })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Label', { exact: true }).fill(text);
    await dialog.getByLabel('Value', { exact: true }).fill(value);
    await dialog.getByLabel('Sort order', { exact: true }).fill(String(ordinal));
    await save(dialog);
  }
  beforeAll(async () => {
    f = await dictionaryFixture(process.env.TEST_DATABASE_URL!, origin);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    vite = spawn(
      'pnpm',
      ['exec', 'vite', '--host', 'localhost', '--port', '4331', '--strictPort'],
      {
        cwd: resolve('../admin'),
        env: {
          ...process.env,
          NODE_ENV: 'development',
          pnpm_config_verify_deps_before_run: 'false',
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
    await page.goto('/login');
    await page.getByPlaceholder('Username', { exact: true }).fill('dictadmin');
    await page.getByPlaceholder('Password', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await browserExpect(page).not.toHaveURL(/\/login$/);
    await page.goto('/dictionary');
  }, 65000);
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
  it('creates canonical dictionary types and items and does not leak the other selected dictionary into its query', async () => {
    first = await createType('Synthetic Dictionary Alpha', 'alpha');
    second = await createType('Synthetic Dictionary Beta', 'beta');
    await select(first.name);
    await createItem('Alpha item', 'shared', 2);
    firstItem = (
      (await f.database
        .model('dictionaryItem')
        .findMany({ where: { dictId: first.id } })) as Array<{ id: string }>
    )[0].id;
    expect(
      await f.database.model('dictionaryItem').findUnique({ where: { id: firstItem } }),
    ).toMatchObject({ text: 'Alpha item', value: 'shared', ordinal: 2 });
    await select(second.name);
    await createItem('Beta item', 'shared', 5);
    const query = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/dictionary-item/_query'),
    );
    await select(first.name);
    expect((await query).postDataJSON().filter).toEqual({ dictId: first.id });
    await browserExpect(items().getByText('Alpha item', { exact: true })).toBeVisible();
    await browserExpect(items().getByText('Beta item', { exact: true })).toHaveCount(0);
    await items()
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'Alpha item', exact: true }) })
      .getByRole('checkbox')
      .check();
    await select(second.name);
    await browserExpect(items().getByText('Beta item', { exact: true })).toBeVisible();
    await browserExpect(items().getByRole('button', { name: /Delete selected/ })).toHaveCount(0);
  });
  it('retains a rejected duplicate draft and persists dictionary and item edits through real PUT routes', async () => {
    await select(first.name);
    await items()
      .getByRole('button', { name: /Create$/ })
      .click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Label', { exact: true }).fill('Second alpha item');
    await dialog.getByLabel('Value', { exact: true }).fill('shared');
    await dialog.getByRole('button', { name: /OK$/ }).click();
    await browserExpect(page.getByText(/Dictionary save was not confirmed/)).toBeVisible();
    await browserExpect(dialog.getByLabel('Label', { exact: true })).toHaveValue(
      'Second alpha item',
    );
    await dialog.getByLabel('Value', { exact: true }).fill('second');
    await save(dialog);
    await dictionaries()
      .getByRole('row')
      .filter({ hasText: first.name })
      .getByText('Edit', { exact: true })
      .click();
    dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('Dictionary name', { exact: true })
      .fill('Synthetic Dictionary Renamed');
    await save(dialog);
    first.name = 'Synthetic Dictionary Renamed';
    await browserExpect(items().getByText(/Synthetic Dictionary Renamed/)).toBeVisible();
    await items()
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'Alpha item', exact: true }) })
      .getByText('Edit', { exact: true })
      .click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Label', { exact: true }).fill('Alpha updated');
    await dialog.getByLabel('Sort order', { exact: true }).fill('7');
    await f.withFailedUpdate('dictionary_items', async () => {
      await dialog.getByRole('button', { name: /OK$/ }).click();
      await browserExpect(page.getByText(/Dictionary save was not confirmed/).last()).toBeVisible();
      await browserExpect(dialog.getByLabel('Label', { exact: true })).toHaveValue('Alpha updated');
      expect(
        await f.database.model('dictionaryItem').findUnique({ where: { id: firstItem } }),
      ).toMatchObject({ text: 'Alpha item', ordinal: 2 });
    });
    await browserExpect(dialog.getByRole('button', { name: /OK$/ })).not.toHaveClass(
      /ant-btn-loading/,
    );
    await save(dialog);
    expect(
      await f.database.model('dictionaryItem').findUnique({ where: { id: firstItem } }),
    ).toMatchObject({ text: 'Alpha updated', ordinal: 7 });
  });
  it('deletes only the selected dictionary and renders the item editor without overflow at 390px', async () => {
    await select(second.name);
    await dictionaries()
      .getByRole('row')
      .filter({ hasText: second.name })
      .getByText('Delete', { exact: true })
      .click();
    await page.getByRole('button', { name: /OK$/ }).click();
    await browserExpect(dictionaries().getByText(second.name, { exact: true })).toHaveCount(0);
    expect(await f.database.model('dictionaryItem').count({ where: { dictId: second.id } })).toBe(
      0,
    );
    expect(await f.database.model('dictionaryItem').count({ where: { dictId: first.id } })).toBe(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await select(first.name);
    await items()
      .getByRole('button', { name: /Create$/ })
      .click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByLabel('Label', { exact: true })).toBeVisible();
    await dialog.getByLabel('Label', { exact: true }).fill('Synthetic mobile draft');
    await dialog.getByText('Create dictionary item', { exact: true }).scrollIntoViewIfNeeded();
    await browserExpect(page.locator('.ant-message-notice')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: '/private/tmp/zucker-dictionary-mobile-20261024.png',
      animations: 'disabled',
    });
  });
});
