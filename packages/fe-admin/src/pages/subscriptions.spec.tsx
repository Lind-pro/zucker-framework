import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../test/harness';
import { assignmentInitialValues, assignmentPayload } from './subscriptions';

const row = {
  id: 's1',
  userId: 'u1',
  status: 'ACTIVE',
  billingCycle: 'MONTHLY',
  startDate: '2026-11-01T00:00:00.000Z',
  endDate: '2026-12-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  canceledAt: null,
  source: 'admin',
  active: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  user: { id: 'u1', username: 'alice', email: 'alice@example.test' },
  plan: { id: 'p1', slug: 'pro', name: 'Pro' },
};
const catalog = { features: [], counters: [{ key: 'documents', label: 'Documents', period: 'month' }] };

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /menu/tree': [],
    'GET /billing/entitlements/catalog': catalog,
    'GET /management/subscriptions': { data: [row], total: 1, page: 1, pageSize: 20 },
    'GET /management/plans': [
      { id: 'p1', slug: 'pro', name: 'Pro', status: true },
      { id: 'p2', slug: 'team', name: 'Team', status: false },
    ],
    ...extra,
  };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('user subscriptions', () => {
  it('assigns a subscription with the RFC §8.3 body', async () => {
    const server = createMockServer(
      routes({ 'PUT /management/subscriptions/u2': ({ body }: { body: unknown }) => ({ data: { ...row, userId: 'u2', ...(body as object) } }) }),
    );
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/user-subscriptions', permissions: ['subscriptions:query', 'subscriptions:update', 'plans:query'] });
    expect(await within(await screen.findByRole('table', { name: '用户订阅' })).findByText('alice')).toBeTruthy();
    expect(server.find('GET', '/management/subscriptions')[0]!.params).toMatchObject({ page: 1, pageSize: 20 });

    fireEvent.click(screen.getByRole('button', { name: '指派订阅' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('请填写账户ID')).toBeTruthy();
    expect(server.find('PUT', '/management/subscriptions/u2')).toHaveLength(0);

    // The required plan select shows an empty choice instead of pretending the first plan is chosen.
    expect((within(dialog).getByLabelText(/^套餐/) as HTMLSelectElement).value).toBe('');
    expect(await within(dialog).findByText('请填写套餐')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText(/账户ID/), { target: { value: 'u2' } });
    fireEvent.change(within(dialog).getByLabelText(/^套餐/), { target: { value: 'team' } });
    fireEvent.change(within(dialog).getByLabelText(/计费周期/), { target: { value: 'YEARLY' } });
    fireEvent.change(within(dialog).getByLabelText(/开始时间/), { target: { value: '2026-12-01T09:30' } });
    fireEvent.change(within(dialog).getByLabelText(/到期时间/), { target: { value: '2026-11-01T00:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('到期时间必须晚于开始时间')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText(/到期时间/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.find('PUT', '/management/subscriptions/u2')).toHaveLength(1));
    expect(server.find('PUT', '/management/subscriptions/u2')[0]!.body).toEqual({
      planSlug: 'team',
      billingCycle: 'YEARLY',
      status: 'ACTIVE',
      startDate: new Date('2026-12-01T09:30').toISOString(),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(server.find('GET', '/management/subscriptions').length).toBeGreaterThan(1));
  });

  it('keeps the dialog open when the server refuses because of a pending payment', async () => {
    const server = createMockServer(
      routes({
        'PUT /management/subscriptions/u1': {
          status: 409,
          data: { status: 409, code: 'pending_payment', message: 'Payment pending',
            result: { reason: 'pending_payment', details: { blocking: { kind: 'order', id: 'order-7', state: 'pending' } } } },
        },
      }),
    );
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/user-subscriptions', permissions: ['subscriptions:query', 'subscriptions:update', 'plans:query'] });
    const table = await screen.findByRole('table', { name: '用户订阅' });
    fireEvent.click(await within(table).findByRole('button', { name: '修改订阅' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(/账户ID/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText(/订阅保存失败/)).toBeTruthy();
    // An untouched term keeps its exact dates: none are sent.
    expect(server.find('PUT', '/management/subscriptions/u1')[0]!.body).toEqual({ planSlug: 'pro', billingCycle: 'MONTHLY', status: 'ACTIVE' });
    expect(await screen.findByText(/存在未结算的支付（订单 order-7，状态 pending）/)).toBeTruthy();
  });

  it('shows the quota snapshot from the detail endpoint', async () => {
    const server = createMockServer(
      routes({
        'GET /management/subscriptions/u1': {
          ...row,
          features: {},
          quotas: { documents: { limit: -1, used: 3, reserved: 1, remaining: -1, period: '2026-11' } },
        },
      }),
    );
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/user-subscriptions', permissions: ['subscriptions:query'] });
    const table = await screen.findByRole('table', { name: '用户订阅' });
    expect(within(table).queryByRole('button', { name: '修改订阅' })).toBeNull();
    fireEvent.click(await within(table).findByRole('button', { name: '详情' }));
    const snapshot = await screen.findByRole('table', { name: '额度快照' });
    expect(within(snapshot).getByText('Documents')).toBeTruthy();
    expect(within(snapshot).getAllByText('不限')).toHaveLength(2);
    // Detail labels use the same localized cycle/source text as the table.
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('月付')).toBeTruthy();
    expect(within(drawer).getByText('后台指派')).toBeTruthy();
  });

  it('cancels after confirmation', async () => {
    const server = createMockServer(routes({ 'DELETE /management/subscriptions/u1': { ...row, status: 'CANCELED' } }));
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/user-subscriptions', permissions: ['subscriptions:query', 'subscriptions:update'] });
    const table = await screen.findByRole('table', { name: '用户订阅' });
    fireEvent.click(await within(table).findByRole('button', { name: '取消订阅' }));
    const alert = await screen.findByRole('alertdialog');
    fireEvent.click(within(alert).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(server.find('DELETE', '/management/subscriptions/u1')).toHaveLength(1));
  });
});

describe('assignment payload', () => {
  const base = { ...row, startDate: '2026-11-09T14:22:05.000Z', endDate: '2026-12-09T14:22:05.000Z', source: 'payment' as const };

  it('sends only the edited fields and keeps exact paid dates', () => {
    const initial = assignmentInitialValues(base as never);
    expect(assignmentPayload({ ...initial, status: 'CANCELED' }, initial)).toEqual({ planSlug: 'pro', billingCycle: 'MONTHLY', status: 'CANCELED' });
    expect(assignmentPayload({ ...initial, endDate: '2027-01-01T08:00' }, initial)).toEqual({
      planSlug: 'pro', billingCycle: 'MONTHLY', status: 'ACTIVE', endDate: new Date('2027-01-01T08:00').toISOString(),
    });
  });

  it('never sends an end date for a lifetime term', () => {
    const initial = assignmentInitialValues(base as never);
    expect(assignmentPayload({ ...initial, billingCycle: 'LIFETIME', endDate: '2027-01-01T08:00' }, initial)).toEqual({
      planSlug: 'pro', billingCycle: 'LIFETIME', status: 'ACTIVE',
    });
    expect(assignmentInitialValues({ ...base, billingCycle: 'LIFETIME', endDate: null } as never).endDate).toBe('');
  });
});

describe('lifetime and one-time terms', () => {
  it('hides the end for LIFETIME, requires it for a new ONE_TIME term, and revokes instead of cancelling', async () => {
    const lifetime = { ...row, billingCycle: 'LIFETIME', endDate: null };
    const server = createMockServer(
      routes({
        'GET /management/subscriptions': { data: [lifetime], total: 1, page: 1, pageSize: 20 },
        'PUT /management/subscriptions/u1': ({ body }: { body: unknown }) => ({ data: { ...lifetime, ...(body as object) } }),
      }),
    );
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/user-subscriptions', permissions: ['subscriptions:query', 'subscriptions:update', 'plans:query'] });
    const table = await screen.findByRole('table', { name: '用户订阅' });
    expect(within(table).queryByRole('button', { name: '取消订阅' })).toBeNull();

    fireEvent.click(await within(table).findByRole('button', { name: '修改订阅' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/到期时间/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/计费周期/), { target: { value: 'ONE_TIME' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('一次性订阅需要填写到期时间')).toBeTruthy();
    expect(server.find('PUT', '/management/subscriptions/u1')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(table).getByRole('button', { name: '撤销' }));
    const alert = await screen.findByRole('alertdialog');
    fireEvent.click(within(alert).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(server.find('PUT', '/management/subscriptions/u1')).toHaveLength(1));
    expect(server.find('PUT', '/management/subscriptions/u1')[0]!.body).toEqual({ planSlug: 'pro', billingCycle: 'LIFETIME', status: 'EXPIRED' });
  });

  it('filters by derived validity', async () => {
    const server = createMockServer(routes());
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/user-subscriptions', permissions: ['subscriptions:query'] });
    await screen.findByRole('table', { name: '用户订阅' });
    fireEvent.change(screen.getByLabelText('有效性', { selector: 'select' }), { target: { value: 'inactive' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() => expect(server.find('GET', '/management/subscriptions').at(-1)!.params).toMatchObject({ active: 'inactive', page: 1 }));
  });
});
