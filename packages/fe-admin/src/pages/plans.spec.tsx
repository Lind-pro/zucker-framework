import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../test/harness';
import type { EntitlementCatalog } from './entitlements';
import { emptyPlanDraft, validatePlanDraft, type PlanDraft, type PlanPriceDraft } from './plans';

const catalog: EntitlementCatalog = {
  features: [
    { key: 'export', label: 'Export documents', category: 'metered', counter: 'documents' },
    { key: 'support', label: 'Priority support', category: 'benefit' },
  ],
  counters: [{ key: 'documents', label: 'Documents', unit: 'docs', period: 'month' }],
};

const month = (): PlanPriceDraft => ({ interval: 'month', currency: 'USD', amount: '19.90', termDays: '', providerRefs: { stripe: 'price_1A', paypal: '' } });
const valid = (): PlanDraft => ({
  ...emptyPlanDraft(),
  slug: 'pro',
  name: 'Pro',
  prices: [month()],
  features: { export: true, support: false },
  quotas: { documents: '100' },
});

describe('validatePlanDraft', () => {
  it('builds the RFC §8.2 write payload', () => {
    const { errors, payload } = validatePlanDraft(
      { ...valid(), prices: [month(), { interval: 'one_time', currency: 'EUR', amount: '5', termDays: '30', providerRefs: { creem: 'prod_x' } }] },
      catalog,
    );
    expect(errors).toEqual({});
    expect(payload).toEqual({
      slug: 'pro',
      name: 'Pro',
      description: null,
      order: 0,
      status: false,
      prices: [
        { interval: 'month', currency: 'USD', amount: '19.90', termDays: null, providerRefs: { stripe: 'price_1A' } },
        { interval: 'one_time', currency: 'EUR', amount: '5', termDays: 30, providerRefs: { creem: 'prod_x' } },
      ],
      features: { export: true, support: false },
      quotas: { documents: 100 },
    });
  });

  it('allows a plan without prices (not purchasable)', () => {
    expect(validatePlanDraft({ ...valid(), prices: [] }, catalog).payload?.prices).toEqual([]);
  });

  it.each([
    ['prices.0.amount', { amount: '19.999999' }, 'plans.error.price'],
    ['prices.0.amount', { amount: '-1' }, 'plans.error.price'],
    ['prices.0.amount', { amount: '1e3' }, 'plans.error.price'],
    ['prices.0.currency', { currency: 'usd' }, 'plans.error.currency'],
    ['prices.0.providerRefs.stripe', { providerRefs: { stripe: 'prod_1' } }, 'plans.error.priceId'],
    ['prices.0.termDays', { interval: 'one_time' as const, termDays: '' }, 'plans.error.termDays'],
    ['prices.0.termDays', { interval: 'one_time' as const, termDays: '36501' }, 'plans.error.termDays'],
  ])('rejects invalid %s', (field, patch, key) => {
    const result = validatePlanDraft({ ...valid(), prices: [{ ...month(), ...patch }] }, catalog);
    expect(result.payload).toBeNull();
    expect(result.errors[field]?.key).toBe(key);
  });

  it('rejects duplicate interval + currency and reused provider references', () => {
    const duplicate = validatePlanDraft({ ...valid(), prices: [month(), { ...month(), providerRefs: {} }] }, catalog);
    expect(duplicate.errors['prices.1.currency']?.key).toBe('plans.error.duplicatePrice');
    const reused = validatePlanDraft({ ...valid(), prices: [month(), { ...month(), interval: 'year' }] }, catalog);
    expect(reused.errors['prices.1.providerRefs.stripe']?.key).toBe('plans.error.duplicateRef');
  });

  it.each([
    ['slug', { slug: 'Pro Plan' }, 'plans.error.slug'],
    ['order', { order: '1.5' }, 'plans.error.order'],
  ])('rejects invalid %s', (field, patch, key) => {
    const result = validatePlanDraft({ ...valid(), ...patch }, catalog);
    expect(result.payload).toBeNull();
    expect(result.errors[field]?.key).toBe(key);
  });

  it('accepts -1 as unlimited and omits empty quotas', () => {
    expect(validatePlanDraft({ ...valid(), quotas: { documents: '-1' } }, catalog).payload?.quotas).toEqual({ documents: -1 });
    expect(validatePlanDraft({ ...valid(), quotas: { documents: '' } }, catalog).payload?.quotas).toEqual({});
  });

  it('rejects quota values other than -1 or non-negative integers', () => {
    for (const value of ['-2', '1.5', 'many']) {
      const result = validatePlanDraft({ ...valid(), quotas: { documents: value } }, catalog);
      expect(result.errors['quotas.documents']?.key).toBe('plans.error.quota');
    }
  });

  it('rejects keys outside the entitlement catalog', () => {
    const result = validatePlanDraft({ ...valid(), features: { retired: true }, quotas: { storage: '5' } }, catalog);
    expect(result.errors['features.retired']?.key).toBe('plans.error.feature');
    expect(result.errors['quotas.storage']?.key).toBe('plans.error.quotaKey');
  });
});

describe('PlansPage editor', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('validates in the editor and submits the catalog-driven payload', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /billing/entitlements/catalog': catalog,
      'GET /management/plans': [],
      'POST /management/plans': ({ body }: MockRequest) => ({ data: { id: 'p1', ...(body as object) } }),
    });
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/plans', permissions: ['plans:query', 'plans:add'] });
    const create = await screen.findByRole('button', { name: '新建套餐' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/套餐名称/), { target: { value: 'Pro' } });
    fireEvent.change(within(dialog).getByLabelText(/标识/), { target: { value: 'Pro!' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加价格' }));
    fireEvent.change(within(dialog).getByLabelText(/^币种 1/), { target: { value: 'usd' } });
    fireEvent.change(within(dialog).getByLabelText(/^金额 1/), { target: { value: '19.9.0' } });
    fireEvent.change(within(dialog).getByLabelText(/^stripe 价格引用 1/), { target: { value: 'price_Pro' } });
    fireEvent.change(within(dialog).getByLabelText(/Documents（/), { target: { value: '1.5' } });
    // The Unlimited switch has its own name per counter.
    expect(within(dialog).getByRole('checkbox', { name: 'Documents：不限' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText(/标识只能包含/)).toBeTruthy();
    expect(within(dialog).getByText('额度 documents 必须是 -1 或非负整数')).toBeTruthy();
    expect(within(dialog).getByText('请输入非负金额，最多四位小数')).toBeTruthy();
    // Currency is upper-cased while typing.
    expect((within(dialog).getByLabelText(/^币种 1/) as HTMLInputElement).value).toBe('USD');
    expect(server.find('POST', '/management/plans')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText(/标识/), { target: { value: 'pro' } });
    fireEvent.change(within(dialog).getByLabelText(/^金额 1/), { target: { value: '19.90' } });
    fireEvent.change(within(dialog).getByLabelText(/Documents（/), { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Export documents/ }));
    // Enter inside the form submits it (Save is the form's submit button).
    fireEvent.submit(within(dialog).getByLabelText(/套餐名称/).closest('form')!);
    await waitFor(() => expect(server.find('POST', '/management/plans')).toHaveLength(1));
    expect(server.find('POST', '/management/plans')[0]!.body).toMatchObject({
      slug: 'pro',
      name: 'Pro',
      prices: [{ interval: 'month', currency: 'USD', amount: '19.90', termDays: null, providerRefs: { stripe: 'price_Pro' } }],
      features: { export: true },
      quotas: { documents: 100 },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows server validation issues and keeps the draft', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /billing/entitlements/catalog': catalog,
      'GET /management/plans': [
        {
          id: 'p1', slug: 'pro', name: 'Pro', description: null, status: true, order: 0, features: {}, quotas: {}, revision: 4,
          prices: [{ interval: 'year', currency: 'USD', amount: '190.00', termDays: null, providerRefs: {} }],
          createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      // The template's exception filter envelope around a port error.
      'PUT /management/plans/p1': {
        status: 409,
        data: { status: 409, code: 'conflict', message: 'Plan changed since revision 4', result: { reason: 'conflict' } },
      },
    });
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/plans', permissions: ['plans:query', 'plans:update'] });
    const table = await screen.findByRole('table', { name: '套餐' });
    const edit = await within(table).findByRole('button', { name: '编辑' });
    await waitFor(() => expect((edit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(edit);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/套餐名称/), { target: { value: 'Pro 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText(/保存冲突：Plan changed since revision 4/)).toBeTruthy();
    expect(server.find('PUT', '/management/plans/p1')[0]!.body).toMatchObject({ name: 'Pro 2', expectedRevision: 4,
      prices: [{ interval: 'year', currency: 'USD', amount: '190.00', termDays: null, providerRefs: {} }] });
    expect(within(table).getByText('USD 190.00 / 年')).toBeTruthy();
    expect((within(dialog).getByLabelText(/套餐名称/) as HTMLInputElement).value).toBe('Pro 2');
  });
});

describe('PlansPage price editor', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('shows server validation issues from the envelope and only asks for days on one-time prices', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /billing/entitlements/catalog': catalog,
      'GET /management/plans': [],
      'POST /management/plans': {
        status: 400,
        data: { status: 400, code: 'invalid', message: 'Invalid plan', result: { reason: 'invalid', issues: ['price 1 amount has too many decimals for JPY'] } },
      },
    });
    renderAdmin({ httpAdapter: server.adapter as never, paymentProviders: ['stripe'] }, { path: '/plans', permissions: ['plans:query', 'plans:add'] });
    const create = await screen.findByRole('button', { name: '新建套餐' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/套餐名称/), { target: { value: 'Pass' } });
    fireEvent.change(within(dialog).getByLabelText(/标识/), { target: { value: 'pass' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加价格' }));
    expect(within(dialog).queryByLabelText(/^天数 1/)).toBeNull();
    expect(within(dialog).queryByLabelText(/paypal 价格引用 1/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/^计费周期 1/), { target: { value: 'one_time' } });
    fireEvent.change(within(dialog).getByLabelText(/^币种 1/), { target: { value: 'JPY' } });
    fireEvent.change(within(dialog).getByLabelText(/^金额 1/), { target: { value: '1.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('一次性价格需要 1–36500 的整数天数')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText(/^天数 1/));
    fireEvent.change(within(dialog).getByLabelText(/^天数 1/), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('price 1 amount has too many decimals for JPY')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除价格 1' }));
    expect(within(dialog).getByText('未设置价格（不能在线购买）')).toBeTruthy();
  });
});
