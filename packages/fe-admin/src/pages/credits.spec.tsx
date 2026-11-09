import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, meResponse, renderAdmin } from '../test/harness';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

describe('credit grant idempotency', () => {
  it('reuses the key only to retry the same unconfirmed attempt, not for a later identical grant', async () => {
    let outcome = 503;
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /management/credits': { data: [], total: 0, page: 1, pageSize: 20 },
      'GET /authorize/me': meResponse(['*']),
      'POST /management/credits/u1/grants': () => ({ status: outcome, data: outcome === 200 ? { granted: true } : { message: 'unknown' } }),
    });
    renderAdmin({ httpAdapter: server.adapter as never }, { path: '/credit', permissions: ['*'] });
    const grant = async () => {
      fireEvent.click(await screen.findByRole('button', { name: '发放积分' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(/账户ID/), { target: { value: 'u1' } });
      fireEvent.change(within(dialog).getByLabelText(/积分数量/), { target: { value: '10' } });
      fireEvent.change(within(dialog).getByLabelText(/发放原因/), { target: { value: 'support' } });
      return dialog;
    };
    const keys = () => server.find('POST', '/management/credits/u1/grants').map((call) => call.headers['idempotency-key']);

    const dialog = await grant();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认发放' }));
    await waitFor(() => expect(keys()).toHaveLength(1));
    // Retry of the same unconfirmed attempt: same key.
    fireEvent.click(within(dialog).getByRole('button', { name: '确认发放' }));
    await waitFor(() => expect(keys()).toHaveLength(2));
    expect(keys()[1]).toBe(keys()[0]);

    // Dismissing ends the attempt; a deliberate identical grant later is a new operation.
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    outcome = 200;
    const again = await grant();
    fireEvent.click(within(again).getByRole('button', { name: '确认发放' }));
    await waitFor(() => expect(keys()).toHaveLength(3));
    expect(keys()[2]).not.toBe(keys()[0]);
  });
});
