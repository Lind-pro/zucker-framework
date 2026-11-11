import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanPreset } from '../app/config';
import { createMockServer, renderAdmin, type MockRequest } from '../test/harness';
import type { EntitlementCatalog } from './entitlements';

const catalog: EntitlementCatalog = {
  features: [{ key: 'export', label: 'Export documents', category: 'metered', counter: 'documents' }],
  counters: [{ key: 'documents', label: 'Documents', unit: 'docs', period: 'month' }],
};
const basic: PlanPreset = { key: 'basic', label: '基础版草稿', plan: { slug: 'basic', name: '基础版', prices: [{ interval: 'month', currency: 'CNY', amount: 99 }], features: { export: true }, quotas: { documents: 2 } } };
const yearly: PlanPreset = { key: 'yearly', label: '年付草稿', description: '年付说明', plan: { slug: 'yearly', name: '年付版', status: true, prices: [{ interval: 'year', currency: 'CNY', amount: '999.50' }] } };
const ghost: PlanPreset = { key: 'ghost', label: '未知功能草稿', plan: { slug: 'ghost', name: '未知', features: { 'no-such-feature': true } as never, quotas: { 'no-such-counter': 1 } as never } };

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function mount(presets: PlanPreset[]) {
  const mock = createMockServer({
    'GET /menu/tree': [],
    'GET /billing/entitlements/catalog': catalog,
    'GET /management/plans': [],
    'POST /management/plans': ({ body }: MockRequest) => ({ data: { id: 'p1', ...(body as object) } }),
  });
  renderAdmin({ httpAdapter: mock.adapter as never, plans: { presets } }, { path: '/plans', permissions: ['plans:query', 'plans:add'] });
  return mock;
}
async function openPreset(name: string) {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  return screen.findByRole('dialog');
}
const cancel = async (dialog: HTMLElement) => {
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
};

describe('plan presets: edge cases', () => {
  it('one button per preset; the next preset starts from its own values, never from the previous draft', async () => {
    const mock = mount([basic, yearly]);
    let dialog = await openPreset('基础版草稿');
    expect((within(dialog).getByLabelText(/套餐名称/) as HTMLInputElement).value).toBe('基础版');
    expect((within(dialog).getByLabelText(/^金额 1/) as HTMLInputElement).value).toBe('99');
    fireEvent.change(within(dialog).getByLabelText(/套餐名称/), { target: { value: '手工修改' } });
    await cancel(dialog);
    dialog = await openPreset('年付草稿');
    expect((within(dialog).getByLabelText(/套餐名称/) as HTMLInputElement).value).toBe('年付版');
    expect((within(dialog).getByLabelText(/^金额 1/) as HTMLInputElement).value).toBe('999.50');
    expect(within(dialog).getByText('年付说明')).toBeTruthy();
    expect(within(dialog).queryByDisplayValue('手工修改')).toBeNull();
    await cancel(dialog);
    // The plain create button still opens an empty editor.
    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }));
    const empty = await screen.findByRole('dialog');
    expect((within(empty).getByLabelText(/套餐名称/) as HTMLInputElement).value).toBe('');
    expect(mock.find('POST', '/management/plans')).toHaveLength(0);
  });

  it('an unlisted preset is saved unlisted and a listed one only when it says so', async () => {
    const mock = mount([basic, yearly]);
    let dialog = await openPreset('基础版草稿');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mock.find('POST', '/management/plans')).toHaveLength(1));
    expect(mock.find('POST', '/management/plans')[0]!.body).toMatchObject({ slug: 'basic', status: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await openPreset('年付草稿');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mock.find('POST', '/management/plans')).toHaveLength(2));
    expect(mock.find('POST', '/management/plans')[1]!.body).toMatchObject({ slug: 'yearly', status: true, prices: [{ interval: 'year', amount: '999.50' }] });
  });

  it('a preset naming features or counters outside the catalog is flagged and cannot be saved as it is', async () => {
    const mock = mount([ghost]);
    const dialog = await openPreset('未知功能草稿');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mock.find('POST', '/management/plans')).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows no preset button while no preset is configured', async () => {
    mount([]);
    await screen.findByRole('button', { name: '新建套餐' });
    expect(screen.queryByRole('button', { name: /草稿/ })).toBeNull();
  });
});
