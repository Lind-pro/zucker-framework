/** Component tests for the referrals page (features/referrals). */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../../../packages/fe-admin/src/test/harness';
import { REFERRAL_REWARD_STATUSES, referralPages } from '../src/features/referrals';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const base = {
  refereeId: 'ref-1', referrerId: 'owner-1', code: 'ABCD2345', boundAt: '2026-11-01T10:00:00.000Z', rewardStatus: 'pending', skipReason: null,
  orderId: null, referrerCredits: null, refereeCredits: null, rewardedAt: null, codeDisabled: false,
};
const granted = { ...base, refereeId: 'ref-2', rewardStatus: 'granted', orderId: 'order-9', referrerCredits: 100, refereeCredits: 50, rewardedAt: '2026-11-09T10:00:00.000Z' };
const skipped = { ...base, refereeId: 'ref-3', referrerId: 'owner-2', code: 'ZZZZ2222', rewardStatus: 'skipped', skipReason: 'cap-reached', codeDisabled: true };
const rows = [base, granted, skipped];

function mount(permissions: string[], routes: Record<string, unknown> = {}) {
  const server = createMockServer({
    'GET /menu/tree': [],
    'GET /management/referrals': { data: rows, total: 3, page: 1, pageSize: 20 },
    ...routes,
  });
  renderAdmin({ httpAdapter: server.adapter as never, locales, extraPages: referralPages }, { path: '/referrals', permissions });
  return server;
}

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('referrals page', () => {
  it('is registered under referrals:query and offers the three reward statuses', () => {
    expect(referralPages).toHaveLength(1);
    expect(referralPages[0]).toMatchObject({ path: '/referrals', permission: 'referrals:query' });
    expect([...REFERRAL_REWARD_STATUSES]).toEqual(['pending', 'granted', 'skipped']);
  });

  it('shows the reward decision per row: pending, granted credits, skip reason, disabled code', async () => {
    mount(['referrals:query']);
    const table = within(await screen.findByRole('table', { name: 'Referrals' }));
    expect((await table.findAllByText('ref-1')).length).toBeGreaterThan(0);
    expect(table.getByText('Pending')).toBeTruthy();
    expect(table.getByText('Granted')).toBeTruthy();
    expect(table.getByText('Skipped')).toBeTruthy();
    expect(table.getByText('100 / 50')).toBeTruthy();
    expect(table.getByText('Referrer limit reached')).toBeTruthy();
    expect(table.getByText('ZZZZ2222 (disabled)')).toBeTruthy();
    expect(table.getByText('order-9')).toBeTruthy();
  });

  it('read-only without referrals:update: no code actions and no PATCH is ever sent', async () => {
    const server = mount(['referrals:query']);
    await screen.findAllByText('ref-1');
    expect(screen.queryByRole('button', { name: 'Disable code' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable code' })).toBeNull();
    expect(server.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('disables a referrer code only after confirmation, targeting the referrer id', async () => {
    const server = mount(['referrals:query', 'referrals:update'], { 'PATCH /management/referrals/codes/owner-1': { userId: 'owner-1', code: 'ABCD2345', disabled: true } });
    await screen.findAllByText('ref-1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable code' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    expect(server.find('PATCH', '/management/referrals/codes/owner-1')).toHaveLength(0);
    fireEvent.click(within(dialog).getAllByRole('button').find((button) => /confirm|ok|yes/i.test(button.textContent ?? ''))!);
    await waitFor(() => expect(server.find('PATCH', '/management/referrals/codes/owner-1')).toHaveLength(1));
    expect(server.find('PATCH', '/management/referrals/codes/owner-1')[0]!.body).toEqual({ disabled: true });
    await waitFor(() => expect(server.find('GET', '/management/referrals').length).toBeGreaterThan(1)); // table reloaded
  });

  it('a disabled code offers re-enabling and cancelling the dialog sends nothing', async () => {
    const server = mount(['referrals:query', 'referrals:update'], { 'PATCH /management/referrals/codes/owner-2': { userId: 'owner-2', code: 'ZZZZ2222', disabled: false } });
    await screen.findAllByText('ref-3');
    fireEvent.click(screen.getAllByRole('button', { name: 'Enable code' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getAllByRole('button').find((button) => /cancel/i.test(button.textContent ?? ''))!);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.find('PATCH', '/management/referrals/codes/owner-2')).toHaveLength(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Enable code' })[0]!);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getAllByRole('button').find((button) => /confirm|ok|yes/i.test(button.textContent ?? ''))!);
    await waitFor(() => expect(server.find('PATCH', '/management/referrals/codes/owner-2')).toHaveLength(1));
    expect(server.find('PATCH', '/management/referrals/codes/owner-2')[0]!.body).toEqual({ disabled: false });
  });

  it('a 403 from the server is explained and the table keeps its rows', async () => {
    const server = mount(['referrals:query', 'referrals:update'], { 'PATCH /management/referrals/codes/owner-1': { status: 403, data: { message: 'forbidden' } } });
    await screen.findAllByText('ref-1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable code' })[0]!);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getAllByRole('button').find((button) => /confirm|ok|yes/i.test(button.textContent ?? ''))!);
    await waitFor(() => expect(server.find('PATCH', '/management/referrals/codes/owner-1')).toHaveLength(1));
    expect(await screen.findByText('Permission denied')).toBeTruthy();
    expect(screen.getAllByText('ref-1').length).toBeGreaterThan(0);
  });

  it('filters are sent to the server as query parameters', async () => {
    const server = mount(['referrals:query']);
    await screen.findAllByText('ref-1');
    fireEvent.change(screen.getAllByLabelText('Code')[0]!, { target: { value: 'ABCD2345' } });
    fireEvent.change(screen.getAllByLabelText('Status')[0]!, { target: { value: 'granted' } });
    fireEvent.click(screen.getByRole('button', { name: /search|query|查询/i }));
    await waitFor(() => expect(server.find('GET', '/management/referrals').some((call) => call.params.code === 'ABCD2345' && call.params.status === 'granted')).toBe(true));
  });

  it('shows a retryable error instead of an empty table when the list fails', async () => {
    mount(['referrals:query'], { 'GET /management/referrals': { status: 500, data: { message: 'down' } } });
    expect(await screen.findByRole('button', { name: /retry|重试/i })).toBeTruthy();
    expect(screen.queryByText('ref-1')).toBeNull();
  });
});
