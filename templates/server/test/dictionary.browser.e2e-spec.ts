import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expect as browserExpect, type Browser, type Locator, type Page } from '@playwright/test';
import { dictionaryFixture } from './helpers/dictionary-fixture';
import { artifact, isolatedContext, launchBrowser, newPage, noHorizontalOverflow, record, startAdmin, type AdminServer } from './helpers/fe-admin-browser';
import { loginAs, presetLocale, warmUp } from './helpers/admin-locale-browser';

const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_DICTIONARY_BROWSER === '1' ? describe : describe.skip;
const port = 4331;

run('actual Admin dictionary CRUD and scoped items with PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof dictionaryFixture>>, admin: AdminServer, browser: Browser, page: Page;
  let first: { id: string; name: string }, second: { id: string; name: string }, firstItem: string;
  const pageErrors: string[] = [];
  /** The panels are sections titled "Dictionary types" and "<type> — Dictionary items". */
  const panel = (title: RegExp) => page.locator('main section section').filter({ has: page.getByRole('heading', { level: 2, name: title }) });
  const dictionaries = () => panel(/^Dictionary types$/);
  const items = () => panel(/Dictionary items$/);
  const saveFailed = /The save was not confirmed/;
  async function save(dialog: Locator) {
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
  }
  async function select(name: string) {
    await record(dictionaries(), name).getByRole('button', { name: 'View items', exact: true }).click();
    await browserExpect(items().getByRole('heading', { level: 2 })).toHaveText(`${name} — Dictionary items`);
  }
  async function createType(name: string, classified: string) {
    await dictionaries().getByRole('button', { name: 'Create', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create dictionary type', exact: true });
    await dialog.getByRole('textbox', { name: 'Dictionary name', exact: true }).fill(name);
    await dialog.getByRole('textbox', { name: 'Category code', exact: true }).fill(classified);
    await save(dialog);
    await browserExpect(record(dictionaries(), name)).toBeVisible();
    const rows = (await f.database.model('dictionary').findMany({ where: { name } })) as Array<{ id: string; name: string }>;
    expect(rows).toHaveLength(1);
    return rows[0];
  }
  async function createItem(text: string, value: string, ordinal: number) {
    await items().getByRole('button', { name: 'Create', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create dictionary item', exact: true });
    await dialog.getByRole('textbox', { name: 'Label', exact: true }).fill(text);
    await dialog.getByRole('textbox', { name: 'Value', exact: true }).fill(value);
    await dialog.getByRole('spinbutton', { name: 'Order', exact: true }).fill(String(ordinal));
    await save(dialog);
    await browserExpect(record(items(), text)).toBeVisible();
  }
  const itemRow = (text: string) => items().getByRole('row').filter({ has: page.getByRole('cell', { name: text, exact: true }) });
  beforeAll(async () => {
    f = await dictionaryFixture(process.env.TEST_DATABASE_URL!, `http://localhost:${port}`);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API not listening');
    admin = await startAdmin(port, address.port);
    browser = await launchBrowser();
    const context = await isolatedContext(browser, admin.origin);
    await presetLocale(context, 'en-US');
    page = await newPage(context);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await warmUp(page);
    await loginAs(page, 'dictadmin', f.password, 'en-US');
    await page.goto('/dictionary');
  }, 65_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({ path: artifact('dictionary-failure.png'), fullPage: true, animations: 'disabled' });
      console.info('Dictionary failure view:', page.url(), (await page.locator('body').ariaSnapshot()).slice(0, 4000));
    }
  });
  afterAll(async () => {
    await browser?.close();
    await admin?.stop();
    await f?.close();
  });

  it('creates canonical dictionary types and items and does not leak the other selected dictionary into its query', async () => {
    first = await createType('Synthetic Dictionary Alpha', 'alpha');
    second = await createType('Synthetic Dictionary Beta', 'beta');
    await select(first.name);
    await createItem('Alpha item', 'shared', 2);
    firstItem = ((await f.database.model('dictionaryItem').findMany({ where: { dictId: first.id } })) as Array<{ id: string }>)[0].id;
    expect(await f.database.model('dictionaryItem').findUnique({ where: { id: firstItem } })).toMatchObject({
      text: 'Alpha item',
      value: 'shared',
      ordinal: 2,
    });
    await select(second.name);
    await createItem('Beta item', 'shared', 5);
    const query = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/dictionary-item/_query'));
    await select(first.name);
    expect((await query).postDataJSON().filter).toEqual({ dictId: first.id });
    await browserExpect(itemRow('Alpha item')).toBeVisible();
    await browserExpect(itemRow('Beta item')).toHaveCount(0);
    // A selection belongs to the dictionary it was made in.
    await itemRow('Alpha item').getByRole('checkbox').check();
    await browserExpect(items().getByRole('button', { name: /^Delete selected/ })).toBeVisible();
    await select(second.name);
    await browserExpect(itemRow('Beta item')).toBeVisible();
    await browserExpect(items().getByRole('button', { name: /^Delete selected/ })).toHaveCount(0);
  });

  it('retains a rejected duplicate draft and persists dictionary and item edits through real PUT routes', async () => {
    await select(first.name);
    await items().getByRole('button', { name: 'Create', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Create dictionary item', exact: true });
    await dialog.getByRole('textbox', { name: 'Label', exact: true }).fill('Second alpha item');
    await dialog.getByRole('textbox', { name: 'Value', exact: true }).fill('shared');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog.getByText(saveFailed)).toBeVisible();
    await browserExpect(dialog.getByRole('textbox', { name: 'Label', exact: true })).toHaveValue('Second alpha item');
    await dialog.getByRole('textbox', { name: 'Value', exact: true }).fill('second');
    await save(dialog);
    expect(await f.database.model('dictionaryItem').count({ where: { dictId: first.id } })).toBe(2);

    await record(dictionaries(), first.name).getByRole('button', { name: 'Edit', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Edit dictionary type', exact: true });
    await dialog.getByRole('textbox', { name: 'Dictionary name', exact: true }).fill('Synthetic Dictionary Renamed');
    await save(dialog);
    first.name = 'Synthetic Dictionary Renamed';
    await browserExpect(items().getByRole('heading', { level: 2 })).toHaveText('Synthetic Dictionary Renamed — Dictionary items');
    expect(await f.database.model('dictionary').findUnique({ where: { id: first.id } })).toMatchObject({ name: first.name, classified: 'alpha' });

    await itemRow('Alpha item').getByRole('button', { name: 'Edit', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Edit dictionary item', exact: true });
    await dialog.getByRole('textbox', { name: 'Label', exact: true }).fill('Alpha updated');
    await dialog.getByRole('spinbutton', { name: 'Order', exact: true }).fill('7');
    await f.withFailedUpdate('dictionary_items', async () => {
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await browserExpect(dialog.getByText(saveFailed)).toBeVisible();
      await browserExpect(dialog.getByRole('textbox', { name: 'Label', exact: true })).toHaveValue('Alpha updated');
      expect(await f.database.model('dictionaryItem').findUnique({ where: { id: firstItem } })).toMatchObject({ text: 'Alpha item', ordinal: 2 });
    });
    await browserExpect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await save(dialog);
    expect(await f.database.model('dictionaryItem').findUnique({ where: { id: firstItem } })).toMatchObject({ text: 'Alpha updated', ordinal: 7 });
    await browserExpect(itemRow('Alpha updated')).toBeVisible();
  });

  it('deletes only the selected dictionary and renders the item editor without overflow at 390px', async () => {
    await select(second.name);
    await record(dictionaries(), second.name).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await browserExpect(record(dictionaries(), second.name)).toHaveCount(0);
    // Deleting the selected type clears the item panel instead of showing stale items.
    await browserExpect(page.getByText('Select a dictionary type to view its items', { exact: true })).toBeVisible();
    expect(await f.database.model('dictionaryItem').count({ where: { dictId: second.id } })).toBe(0);
    expect(await f.database.model('dictionaryItem').count({ where: { dictId: first.id } })).toBe(2);

    await page.setViewportSize({ width: 390, height: 844 });
    await select(first.name);
    await items().getByRole('button', { name: 'Create', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create dictionary item', exact: true });
    await browserExpect(dialog.getByRole('textbox', { name: 'Label', exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Label', exact: true }).fill('Synthetic mobile draft');
    await browserExpect.poll(async () => (await dialog.boundingBox())?.width ?? 1000).toBeLessThanOrEqual(390);
    await browserExpect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: artifact('dictionary-mobile.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await f.database.model('dictionaryItem').count({ where: { dictId: first.id } })).toBe(2);
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(pageErrors).toEqual([]);
  });
});
