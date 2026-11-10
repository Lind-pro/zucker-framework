/** Launch-readiness coverage for the credit pack admin page (list, unlist, delete, translations, permissions). */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../test/harness';
import { enUS } from '../i18n/en-US';
import { zhCN } from '../i18n/zh-CN';
import {
  creditPackToDraft,
  emptyCreditPackDraft,
  validateCreditPackDraft,
  type CreditPack,
  type CreditPackDraft,
} from './credit-packs';

const base = {
  id: 'k1',
  slug: 'starter',
  title: 'Starter',
  titleI18n: {},
  description: null,
  descriptionI18n: {},
  credits: 1000,
  expiresInDays: 30,
  status: true,
  order: 2,
  revision: 3,
  prices: [{ currency: 'USD', amount: '9.90', providerRefs: { stripe: 'price_A' } }],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
} as unknown as CreditPack;
const second = { ...base, id: 'k2', slug: 'big', title: 'Big', credits: 50000, expiresInDays: null, status: false, order: 1, prices: [] } as unknown as CreditPack;

const valid = (over: Partial<CreditPackDraft> = {}): CreditPackDraft => ({
  ...emptyCreditPackDraft(),
  slug: 'starter',
  title: 'Starter',
  credits: '10',
  ...over,
});

describe('validateCreditPackDraft edges', () => {
  it('slug bounds and charset', () => {
    for (const slug of ['a', '0', 'a-b_c', 'a'.repeat(64)]) expect(validateCreditPackDraft(valid({ slug })).payload).not.toBeNull();
    for (const slug of ['', ' ', '-a', '_a', 'A', 'a b', 'a'.repeat(65), 'é'])
      expect(validateCreditPackDraft(valid({ slug })).errors.slug, JSON.stringify(slug)).toBeDefined();
    expect(validateCreditPackDraft(valid({ slug: '  trimmed  ' })).payload?.slug).toBe('trimmed');
  });

  it('title is 1..100 chars without control characters', () => {
    expect(validateCreditPackDraft(valid({ title: 'x'.repeat(100) })).payload).not.toBeNull();
    for (const title of ['', '   ', 'x'.repeat(101), 'a\u0000b', 'a\nb', 'a\u007fb'])
      expect(validateCreditPackDraft(valid({ title })).errors.title, JSON.stringify(title)).toBeDefined();
  });

  it('description limit 2000 and empty becomes null', () => {
    expect(validateCreditPackDraft(valid({ description: 'x'.repeat(2000) })).payload?.description).toHaveLength(2000);
    expect(validateCreditPackDraft(valid({ description: 'x'.repeat(2001) })).errors.description).toBeDefined();
    expect(validateCreditPackDraft(valid({ description: '   ' })).payload?.description).toBeNull();
  });

  it('credits must be a positive safe integer within the int32 ceiling', () => {
    expect(validateCreditPackDraft(valid({ credits: '1' })).payload?.credits).toBe(1);
    expect(validateCreditPackDraft(valid({ credits: '2147483647' })).payload?.credits).toBe(2147483647);
    for (const credits of ['', '0', '-1', '1.5', '1e3', ' abc', '2147483648', '99999999999999999999', '０１'])
      expect(validateCreditPackDraft(valid({ credits })).errors.credits, credits).toBeDefined();
  });

  it('expiry is empty (never) or 1..36500 days', () => {
    expect(validateCreditPackDraft(valid({ expiresInDays: '' })).payload?.expiresInDays).toBeNull();
    expect(validateCreditPackDraft(valid({ expiresInDays: '36500' })).payload?.expiresInDays).toBe(36500);
    for (const expiresInDays of ['0', '36501', '-3', '1.5', 'x'])
      expect(validateCreditPackDraft(valid({ expiresInDays })).errors.expiresInDays, expiresInDays).toBeDefined();
  });

  it('order is a safe integer within +-1,000,000', () => {
    expect(validateCreditPackDraft(valid({ order: '-5' })).payload?.order).toBe(-5);
    expect(validateCreditPackDraft(valid({ order: '1000000' })).payload?.order).toBe(1_000_000);
    for (const order of ['', ' ', '1000001', '1.5', 'a']) expect(validateCreditPackDraft(valid({ order })).errors.order, order).toBeDefined();
  });

  it('prices keep exact decimal strings and reject malformed amounts, currencies and duplicates', () => {
    const price = (amount: string, currency = 'USD') => ({ currency, amount, providerRefs: {} });
    expect(validateCreditPackDraft(valid({ prices: [price('0.0001'), price('123456789012.1234', 'EUR')] })).payload?.prices.map((p) => p.amount)).toEqual(['0.0001', '123456789012.1234']);
    for (const amount of ['', '-1', '01', '1.', '.5', '1.12345', '1e2', '1,5', '1234567890123'])
      expect(validateCreditPackDraft(valid({ prices: [price(amount)] })).errors['prices.0.amount'], amount).toBeDefined();
    for (const currency of ['', 'usd', 'US', 'USDD', 'U$D'])
      expect(validateCreditPackDraft(valid({ prices: [price('1', currency)] })).errors['prices.0.currency'], currency).toBeDefined();
    const dup = validateCreditPackDraft(valid({ prices: [price('1'), price('2'), price('3', 'EUR')] }));
    expect(Object.keys(dup.errors)).toEqual(['prices.1.currency']);
  });

  it('provider refs: stripe format, charset, length, controls and cross-row uniqueness; blanks dropped', () => {
    const row = (providerRefs: Record<string, string>, currency = 'USD') => ({ currency, amount: '1', providerRefs });
    const run = (rows: ReturnType<typeof row>[]) => validateCreditPackDraft(valid({ prices: rows }));
    expect(run([row({ stripe: 'price_Abc123', paypal: 'PLAN-1', creem: '' })]).payload?.prices[0]?.providerRefs).toEqual({ stripe: 'price_Abc123', paypal: 'PLAN-1' });
    expect(run([row({ stripe: 'prod_x' })]).errors['prices.0.providerRefs.stripe']).toBeDefined();
    expect(run([row({ stripe: 'price_' })]).errors['prices.0.providerRefs.stripe']).toBeDefined();
    expect(run([row({ stripe: 'price_a b' })]).errors['prices.0.providerRefs.stripe']).toBeDefined();
    expect(run([row({ paypal: 'x'.repeat(256) })]).errors['prices.0.providerRefs.paypal']).toBeDefined();
    expect(run([row({ paypal: 'x'.repeat(255) })]).payload).not.toBeNull();
    expect(run([row({ paypal: 'a\u0001b' })]).errors['prices.0.providerRefs.paypal']).toBeDefined();
    expect(run([row({ 'Bad Provider': 'x' })]).errors['prices.0.providerRefs.Bad Provider']).toBeDefined();
    // the same reference cannot back two prices of one pack, but the same ref on different providers can
    expect(Object.keys(run([row({ paypal: 'P1' }), row({ paypal: 'P1' }, 'EUR')]).errors)).toEqual(['prices.1.providerRefs.paypal']);
    expect(run([row({ paypal: 'P1', creem: 'P1' })]).payload).not.toBeNull();
  });

  it('translations: only titleI18n/descriptionI18n objects are accepted', () => {
    const t = (translations: string) => validateCreditPackDraft(valid({ translations }));
    expect(t('{"titleI18n":{"en":"Starter"}}').payload).toMatchObject({ titleI18n: { en: 'Starter' }, descriptionI18n: {} });
    expect(t('').payload).toMatchObject({ titleI18n: {}, descriptionI18n: {} });
    for (const bad of ['{', 'null', '[]', '"x"', '3', '{"nameI18n":{}}', '{"titleI18n":{},"extra":1}'])
      expect(t(bad).errors.translations, bad).toBeDefined();
  });

  it('draft round trip: stored pack -> draft -> payload is lossless', () => {
    const rich = { ...base, titleI18n: { en: 'Starter', 'zh-CN': '入门' }, descriptionI18n: { en: 'D' }, description: 'desc', expiresInDays: null } as unknown as CreditPack;
    const { payload, errors } = validateCreditPackDraft(creditPackToDraft(rich));
    expect(errors).toEqual({});
    expect(payload).toEqual({
      slug: 'starter', title: 'Starter', description: 'desc', credits: 1000, expiresInDays: null, order: 2, status: true,
      prices: [{ currency: 'USD', amount: '9.90', providerRefs: { stripe: 'price_A' } }],
      titleI18n: { en: 'Starter', 'zh-CN': '入门' }, descriptionI18n: { en: 'D' },
    });
    // legacy pack without optional arrays still opens
    const legacy = { id: 'k', slug: 's', title: 'T', credits: 5, expiresInDays: null, status: false } as unknown as CreditPack;
    expect(validateCreditPackDraft(creditPackToDraft(legacy)).payload).toMatchObject({ prices: [], order: 0, titleI18n: {} });
  });
});

describe('i18n parity for credit packs', () => {
  it('every zh creditPacks/page key exists in en with identical placeholders', () => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    const keys = Object.keys(zhCN).filter((k) => k.startsWith('creditPacks.') || k === 'page.creditPacks');
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) {
      const en = (enUS as Record<string, string>)[key];
      expect(en, key).toBeTypeOf('string');
      expect(placeholders(en!), key).toBe(placeholders((zhCN as Record<string, string>)[key]!));
    }
  });
});

describe('CreditPacksPage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);
  const mount = (routes: Record<string, unknown>, permissions: string[], extra: Record<string, unknown> = {}) => {
    const server = createMockServer({ 'GET /menu/tree': [], ...routes });
    renderAdmin({ httpAdapter: server.adapter as never, paymentProviders: ['stripe', 'paypal'], ...extra }, { path: '/credit-packs', permissions });
    return server;
  };

  it('lists packs sorted by order with expiry, price and listed state; accepts a {data} envelope', async () => {
    mount({ 'GET /management/credit-packs': { data: [base, second] } }, ['plans:query']);
    const table = await screen.findByRole('table', { name: '积分包' });
    await within(table).findByText('Starter');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('Big'); // order 1 before order 2
    expect(rows[0]!.textContent).toContain('永不过期');
    expect(rows[0]!.textContent).toContain('未上架');
    expect(rows[1]!.textContent).toContain('30 天');
    expect(rows[1]!.textContent).toContain('USD 9.90');
    expect(rows[1]!.textContent).toContain('已上架');
    expect(rows[1]!.textContent).toContain('1,000');
  });

  it('shows a retryable error for a malformed response', async () => {
    let calls = 0;
    mount({ 'GET /management/credit-packs': () => (++calls === 1 ? { data: { nope: true } } : { data: [base] }) }, ['plans:query']);
    const retry = await screen.findByRole('button', { name: /重试|Retry/ });
    fireEvent.click(retry);
    expect((await screen.findAllByText('Starter')).length).toBeGreaterThan(0);
  });

  it('unlist asks for confirmation then PATCHes the inverted status; list does the reverse', async () => {
    const server = mount(
      { 'GET /management/credit-packs': [base, second], 'PATCH /management/credit-packs/k1/status': { data: {} }, 'PATCH /management/credit-packs/k2/status': { data: {} } },
      ['plans:query', 'plans:update'],
    );
    const table = await screen.findByRole('table', { name: '积分包' });
    await within(table).findByText('Starter');
    const rowOf = (name: string) => within(table).getAllByRole('row').find((r) => r.textContent?.includes(name))!;
    fireEvent.click(within(rowOf('Starter')).getByRole('button', { name: '下架' }));
    expect(server.find('PATCH', '/management/credit-packs/k1/status')).toHaveLength(0); // not before confirming
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(server.find('PATCH', '/management/credit-packs/k1/status')).toHaveLength(1));
    expect(server.find('PATCH', '/management/credit-packs/k1/status')[0]!.body).toEqual({ status: false });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(within(rowOf('Big')).getByRole('button', { name: '上架' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(server.find('PATCH', '/management/credit-packs/k2/status')).toHaveLength(1));
    expect(server.find('PATCH', '/management/credit-packs/k2/status')[0]!.body).toEqual({ status: true });
  });

  it('a failed status change does not reload the list as if it succeeded', async () => {
    const server = mount(
      { 'GET /management/credit-packs': [base], 'PATCH /management/credit-packs/k1/status': { status: 409, data: { message: 'changed' } } },
      ['plans:query', 'plans:update'],
    );
    const table = await screen.findByRole('table', { name: '积分包' });
    fireEvent.click(await within(table).findByRole('button', { name: '下架' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(server.find('PATCH', '/management/credit-packs/k1/status')).toHaveLength(1));
    // toasts are global across tests, so assert on state: no reload happened after the failure.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.find('GET', '/management/credit-packs')).toHaveLength(1);
  });

  it('delete requires confirmation and calls DELETE only after it', async () => {
    const server = mount({ 'GET /management/credit-packs': [base], 'DELETE /management/credit-packs/k1': { data: {} } }, ['plans:query', 'plans:delete']);
    const table = await screen.findByRole('table', { name: '积分包' });
    fireEvent.click(await within(table).findByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('删除积分包 Starter？')).toBeTruthy();
    expect(server.find('DELETE', '/management/credit-packs/k1')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(server.find('DELETE', '/management/credit-packs/k1')).toHaveLength(1));
    // list reloaded after the delete
    await waitFor(() => expect(server.find('GET', '/management/credit-packs').length).toBeGreaterThan(1));
  });

  it('each write permission controls only its own action', async () => {
    const check = async (permissions: string[], expected: { create: boolean; edit: boolean; toggle: boolean; del: boolean }) => {
      cleanup();
      mount({ 'GET /management/credit-packs': [base] }, permissions);
      const table = await screen.findByRole('table', { name: '积分包' });
      await within(table).findByText('Starter');
      expect(!!screen.queryByRole('button', { name: '新建积分包' })).toBe(expected.create);
      expect(!!within(table).queryByRole('button', { name: '编辑' })).toBe(expected.edit);
      expect(!!within(table).queryByRole('button', { name: '下架' })).toBe(expected.toggle);
      expect(!!within(table).queryByRole('button', { name: '删除' })).toBe(expected.del);
    };
    await check(['plans:query', 'plans:add'], { create: true, edit: false, toggle: false, del: false });
    await check(['plans:query', 'plans:update'], { create: false, edit: true, toggle: true, del: false });
    await check(['plans:query', 'plans:delete'], { create: false, edit: false, toggle: false, del: true });
  });

  it('is not reachable without plans:query', async () => {
    const server = mount({ 'GET /management/credit-packs': [base] }, ['plans:add']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole('table', { name: '积分包' })).toBeNull();
    expect(server.find('GET', '/management/credit-packs')).toHaveLength(0);
  });

  it('create: server 400 issues are shown joined and the draft is kept; translations round-trip into the body', async () => {
    const server = mount(
      {
        'GET /management/credit-packs': [],
        'POST /management/credit-packs': ({ body }: MockRequest) =>
          (body as { slug: string }).slug === 'dup'
            ? { status: 400, data: { message: 'Invalid', issues: ['titleI18n.xx: unknown locale', 'prices.0.currency: unsupported'] } }
            : { data: { id: 'new', ...(body as object) } },
      },
      ['plans:query', 'plans:add'],
    );
    fireEvent.click(await screen.findByRole('button', { name: '新建积分包' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^名称/), { target: { value: 'Dup' } });
    fireEvent.change(within(dialog).getByLabelText(/^标识/), { target: { value: 'dup' } });
    fireEvent.change(within(dialog).getByLabelText(/^积分数量/), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText('翻译（JSON）'), { target: { value: '{"titleI18n":{"xx":"Dup"}}' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('titleI18n.xx: unknown locale；prices.0.currency: unsupported')).toBeTruthy();
    expect((within(dialog).getByLabelText(/^名称/) as HTMLInputElement).value).toBe('Dup');
    // fix and succeed; translations are sent
    fireEvent.change(within(dialog).getByLabelText(/^标识/), { target: { value: 'ok' } });
    fireEvent.change(within(dialog).getByLabelText('翻译（JSON）'), { target: { value: '{"titleI18n":{"en":"Ok"},"descriptionI18n":{"en":"D"}}' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.find('POST', '/management/credit-packs')).toHaveLength(2));
    expect(server.find('POST', '/management/credit-packs')[1]!.body).toMatchObject({ slug: 'ok', titleI18n: { en: 'Ok' }, descriptionI18n: { en: 'D' }, status: false });
  });

  it('client validation focuses the first invalid field and removing a price clears positional errors', async () => {
    const server = mount({ 'GET /management/credit-packs': [], 'POST /management/credit-packs': { data: {} } }, ['plans:query', 'plans:add']);
    fireEvent.click(await screen.findByRole('button', { name: '新建积分包' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '添加价格' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '添加价格' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('data-field')).toBe('slug'));
    expect(server.find('POST', '/management/credit-packs')).toHaveLength(0);
    expect(dialog.querySelectorAll('[data-field^="prices."][aria-invalid="true"]').length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '删除价格 2' }));
    expect(dialog.querySelectorAll('[data-field^="prices."][aria-invalid="true"]')).toHaveLength(0);
    // second row defaults to an empty currency; first defaults to USD
    expect((dialog.querySelector('[data-field="prices.0.currency"]') as HTMLInputElement).value).toBe('USD');
  });

  it('currency input is upper-cased and one provider-ref field exists per configured provider', async () => {
    mount({ 'GET /management/credit-packs': [] }, ['plans:query', 'plans:add']);
    fireEvent.click(await screen.findByRole('button', { name: '新建积分包' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '添加价格' }));
    const currency = dialog.querySelector<HTMLInputElement>('[data-field="prices.0.currency"]')!;
    fireEvent.change(currency, { target: { value: 'eur' } });
    expect(currency.value).toBe('EUR');
    expect(dialog.querySelector('[data-field="prices.0.providerRefs.stripe"]')).toBeTruthy();
    expect(dialog.querySelector('[data-field="prices.0.providerRefs.paypal"]')).toBeTruthy();
    expect(dialog.querySelector('[data-field="prices.0.providerRefs.creem"]')).toBeNull();
  });

  it('edit preloads the stored values and PUT sends the read revision with an unlisted->listed toggle', async () => {
    const server = mount({ 'GET /management/credit-packs': [second], 'PUT /management/credit-packs/k2': { data: {} } }, ['plans:query', 'plans:update']);
    const table = await screen.findByRole('table', { name: '积分包' });
    fireEvent.click(await within(table).findByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(/^名称/) as HTMLInputElement).value).toBe('Big');
    expect((within(dialog).getByLabelText(/^有效天数/) as HTMLInputElement).value).toBe('');
    fireEvent.click(dialog.querySelector('[data-field="status"]')!);
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.find('PUT', '/management/credit-packs/k2')).toHaveLength(1));
    expect(server.find('PUT', '/management/credit-packs/k2')[0]!.body).toMatchObject({ expectedRevision: 3, status: true, expiresInDays: null, slug: 'big' });
  });
});
