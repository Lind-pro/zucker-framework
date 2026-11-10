import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../test/harness';
import { emptyCreditPackDraft, validateCreditPackDraft } from './credit-packs';

const stored = {
  id: 'k1',
  slug: 'starter',
  title: 'Starter',
  titleI18n: {},
  description: null,
  descriptionI18n: {},
  credits: 1000,
  expiresInDays: 30,
  status: true,
  order: 0,
  revision: 3,
  prices: [{ currency: 'USD', amount: '9.90', providerRefs: { stripe: 'price_A' } }],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

describe('validateCreditPackDraft', () => {
  it('builds the write body with exact decimal prices and empty translations', () => {
    const { errors, payload } = validateCreditPackDraft({
      ...emptyCreditPackDraft(),
      slug: 'starter',
      title: ' Starter ',
      credits: '1000',
      expiresInDays: '',
      prices: [
        { currency: 'USD', amount: '9.90', providerRefs: { stripe: 'price_A', paypal: ' ' } },
      ],
    });
    expect(errors).toEqual({});
    expect(payload).toEqual({
      slug: 'starter',
      title: 'Starter',
      description: null,
      credits: 1000,
      expiresInDays: null,
      order: 0,
      status: false,
      prices: [{ currency: 'USD', amount: '9.90', providerRefs: { stripe: 'price_A' } }],
      titleI18n: {},
      descriptionI18n: {},
    });
  });

  it('reports field paths for invalid credits, expiry, duplicate currencies and translations', () => {
    const { errors, payload } = validateCreditPackDraft({
      ...emptyCreditPackDraft(),
      slug: 'Bad!',
      title: '',
      credits: '0',
      expiresInDays: '40000',
      translations: '{"nameI18n":{}}',
      prices: [
        { currency: 'USD', amount: '1', providerRefs: {} },
        { currency: 'USD', amount: '1.123456', providerRefs: { stripe: 'prod_x' } },
      ],
    });
    expect(payload).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(
      [
        'credits',
        'expiresInDays',
        'prices.1.amount',
        'prices.1.currency',
        'prices.1.providerRefs.stripe',
        'slug',
        'title',
        'translations',
      ].sort(),
    );
  });
});

describe('CreditPacksPage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('creates a pack after client validation', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /management/credit-packs': [],
      'POST /management/credit-packs': ({ body }: MockRequest) => ({
        data: { id: 'k2', ...(body as object) },
      }),
    });
    renderAdmin(
      { httpAdapter: server.adapter as never, paymentProviders: ['stripe'] },
      { path: '/credit-packs', permissions: ['plans:query', 'plans:add'] },
    );
    fireEvent.click(await screen.findByRole('button', { name: '新建积分包' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^名称/), { target: { value: 'Starter' } });
    fireEvent.change(within(dialog).getByLabelText(/^标识/), { target: { value: 'starter' } });
    fireEvent.change(within(dialog).getByLabelText(/^积分数量/), { target: { value: 'abc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('积分必须是 1 到 2147483647 的整数')).toBeTruthy();
    expect(server.find('POST', '/management/credit-packs')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText(/^积分数量/), { target: { value: '500' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加价格' }));
    fireEvent.change(within(dialog).getByLabelText(/^金额 1/), { target: { value: '4.90' } });
    fireEvent.change(within(dialog).getByLabelText(/^stripe 价格引用 1/), {
      target: { value: 'price_B' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.find('POST', '/management/credit-packs')).toHaveLength(1));
    expect(server.find('POST', '/management/credit-packs')[0]!.body).toMatchObject({
      slug: 'starter',
      title: 'Starter',
      credits: 500,
      expiresInDays: null,
      prices: [{ currency: 'USD', amount: '4.90', providerRefs: { stripe: 'price_B' } }],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends expectedRevision on edit and shows a conflict', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /management/credit-packs': [stored],
      'PUT /management/credit-packs/k1': {
        status: 409,
        data: { status: 409, code: 'conflict', message: 'Credit pack changed' },
      },
    });
    renderAdmin(
      { httpAdapter: server.adapter as never },
      { path: '/credit-packs', permissions: ['plans:query', 'plans:update'] },
    );
    const table = await screen.findByRole('table', { name: '积分包' });
    expect(await within(table).findByText('30 天')).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^积分数量/), { target: { value: '1200' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText(/保存冲突：Credit pack changed/)).toBeTruthy();
    expect(server.find('PUT', '/management/credit-packs/k1')[0]!.body).toMatchObject({
      credits: 1200,
      expiresInDays: 30,
      expectedRevision: 3,
    });
  });

  it('hides write actions without plan write permissions', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /management/credit-packs': [stored],
    });
    renderAdmin(
      { httpAdapter: server.adapter as never },
      { path: '/credit-packs', permissions: ['plans:query'] },
    );
    const table = await screen.findByRole('table', { name: '积分包' });
    expect(await within(table).findByText('Starter')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新建积分包' })).toBeNull();
    expect(within(table).queryByRole('button', { name: '编辑' })).toBeNull();
  });
});
