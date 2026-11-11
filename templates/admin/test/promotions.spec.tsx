/** Component tests for the promotions page (features/promotions). */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../../../packages/fe-admin/src/test/harness';
import { emptyPromotionDraft, promotionBody, promotionPages } from '../src/features/promotions';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const row = {
  id: 'p-1', alias: 'SPRING20', providerId: 'stripe', providerCode: 'promo_1', target: '*', currency: null, discountType: 'percent',
  percentOff: 20, amountOff: null, maxRedemptions: 1, status: 'active', startsAt: null, endsAt: null, note: null, revision: 2,
  createdAt: '2026-11-10T10:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z', usage: { redeemed: 0, reserved: 0 },
};

function mount(permissions: string[], routes: Record<string, unknown> = {}) {
  const server = createMockServer({
    'GET /menu/tree': [],
    'GET /management/promotions': { data: [row], total: 1, page: 1, pageSize: 20 },
    'GET /management/promotions/p-1': row,
    'GET /management/promotions/p-1/redemptions': { data: [], total: 0, page: 1, pageSize: 20 },
    ...routes,
  });
  renderAdmin({ httpAdapter: server.adapter as never, locales, extraPages: promotionPages }, { path: '/promotions', permissions });
  return server;
}

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => { cleanup(); localStorage.clear(); });

describe('promotions page', () => {
  it('saves an edit with every field and expectedRevision', async () => {
    const server = mount(['promotions:query', 'promotions:update'], { 'PUT /management/promotions/p-1': { ...row, percentOff: 30, revision: 3 } });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Details' }))[0]!);
    const form = within(await screen.findByRole('form', { name: 'Promotion settings' }));
    fireEvent.change(form.getByLabelText('Percent off'), { target: { value: '30' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.find('PUT', '/management/promotions/p-1')).toHaveLength(1));
    expect(server.find('PUT', '/management/promotions/p-1')[0]!.body).toMatchObject({ alias: 'SPRING20', percentOff: 30, amountOff: null, expectedRevision: 2 });
  });

  it('promotionBody validates before sending', () => {
    expect(promotionBody({ ...emptyPromotionDraft(), providerCode: 'promo_1', percentOff: '100' })).toEqual({ error: 'percentOff' });
    expect(promotionBody({ ...emptyPromotionDraft(), providerCode: 'promo_1', discountType: 'amount', amountOff: '5' })).toEqual({ error: 'currency' });
    expect(promotionBody({ ...emptyPromotionDraft(), providerCode: 'promo_1', percentOff: '15', alias: 'spring' })).toMatchObject({ body: { alias: 'SPRING', percentOff: 15 } });
  });
});
