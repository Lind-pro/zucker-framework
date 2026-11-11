import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig, type PlanPreset } from '../app/config';
import { createMockServer, renderAdmin, type MockRequest } from '../test/harness';
import type { EntitlementCatalog } from './entitlements';
import { presetToDraft } from './plans';

const catalog: EntitlementCatalog = {
  features: [{ key: 'export', label: 'Export documents', category: 'metered', counter: 'documents' }],
  counters: [{ key: 'documents', label: 'Documents', unit: 'docs', period: 'month' }],
};

const professional: PlanPreset = {
  key: 'professional',
  label: { 'zh-CN': '专业版草稿', 'en-US': 'Professional draft' },
  description: '绑定价格后再上架',
  plan: {
    slug: 'professional',
    name: '专业版',
    description: 'Synthetic preset',
    prices: [{ interval: 'month', currency: 'CNY', amount: 299 }],
    features: { export: true },
    quotas: { documents: 5 },
  },
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('presetToDraft', () => {
  it('starts from an empty unlisted plan and keeps decimal strings', () => {
    expect(presetToDraft(professional.plan)).toMatchObject({
      slug: 'professional',
      name: '专业版',
      status: false,
      order: '0',
      prices: [{ interval: 'month', currency: 'CNY', amount: '299', termDays: '', providerRefs: {}, credits: '', creditExpiryMode: 'never' }],
      features: { export: true },
      quotas: { documents: '5' },
    });
  });

  it('rejects duplicate preset keys at configuration time', () => {
    expect(() => resolveConfig({ plans: { presets: [professional, professional] } })).toThrow(/duplicate/);
    expect(resolveConfig({}).planPresets).toEqual([]);
  });
});

describe('plan presets', () => {
  function server() {
    return createMockServer({
      'GET /menu/tree': [],
      'GET /billing/entitlements/catalog': catalog,
      'GET /management/plans': [],
      'POST /management/plans': ({ body }: MockRequest) => ({ data: { id: 'p1', ...(body as object) } }),
    });
  }

  it('fills the editor without saving; saving sends the edited draft once', async () => {
    const mock = server();
    renderAdmin({ httpAdapter: mock.adapter as never, plans: { presets: [professional] } }, { path: '/plans', permissions: ['plans:query', 'plans:add'] });
    const button = await screen.findByRole('button', { name: '专业版草稿' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('已按预设“专业版草稿”填写草稿；保存前不会创建套餐。')).toBeTruthy();
    expect((within(dialog).getByLabelText(/套餐名称/) as HTMLInputElement).value).toBe('专业版');
    expect((within(dialog).getByLabelText(/^金额 1/) as HTMLInputElement).value).toBe('299');
    expect(mock.find('POST', '/management/plans')).toHaveLength(0);

    // Cancelling discards the draft and writes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.find('POST', '/management/plans')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '专业版草稿' }));
    const again = await screen.findByRole('dialog');
    fireEvent.change(within(again).getByLabelText(/套餐名称/), { target: { value: '专业版 2' } });
    fireEvent.click(within(again).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mock.find('POST', '/management/plans')).toHaveLength(1));
    expect(mock.find('POST', '/management/plans')[0]!.body).toMatchObject({
      slug: 'professional',
      name: '专业版 2',
      status: false,
      prices: [{ interval: 'month', currency: 'CNY', amount: '299', termDays: null, providerRefs: {} }],
      features: { export: true },
      quotas: { documents: 5 },
    });
  });

  it('is offered only with plans:add', async () => {
    const mock = server();
    renderAdmin({ httpAdapter: mock.adapter as never, plans: { presets: [professional] } }, { path: '/plans', permissions: ['plans:query'] });
    await screen.findByRole('heading', { name: '套餐' });
    await waitFor(() => expect(mock.find('GET', '/billing/entitlements/catalog')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: '专业版草稿' })).toBeNull();
  });
});
