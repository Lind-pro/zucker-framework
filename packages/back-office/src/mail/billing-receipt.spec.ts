// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { MAIL_TEMPLATE_KEYS, deliverBillingReceipt, resolveMailOptions, type TransactionalMail } from './index';

const paidAt = new Date('2026-06-01T10:30:45Z');
function fixture(overrides: { order?: Record<string, unknown> | null; owner?: Record<string, unknown> | null; alreadySent?: boolean; mailEnabled?: boolean; sendOk?: boolean } = {}) {
  const order = overrides.order === null ? null : { id: 'o1', ownerId: 'u1', fulfilledAt: paidAt,
    offer: { description: 'Pro plan', money: { amount: '20.00', currency: 'USD' } }, ...overrides.order };
  const owner = overrides.owner === null ? null : { email: 'buyer@example.invalid', emailVerified: true, status: true, locale: 'en', name: 'Ada', ...overrides.owner };
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx = {
    model: (name: string) => ({ findUnique: async () => name === 'billingOrders' ? order : name === 'users' ? owner : { credits: 7 } }),
    query: async (sql: string, values: readonly unknown[]) => { queries.push({ sql, values }); return { rows: overrides.alreadySent ? [{ found: 1 }] : [] }; },
  };
  const database = { $transaction: async (work: (tx: unknown) => unknown) => work(tx) } as unknown as DatabaseAdapter;
  const send = vi.fn(async () => overrides.sendOk === false ? { success: false, errorCode: 'X' } : { success: true });
  const mail = { options: resolveMailOptions(), isEnabled: () => overrides.mailEnabled !== false, send,
    locale: (locale: string | null) => locale?.startsWith('zh') ? 'zh' : 'en', link: (_l: string, path: string) => `https://app.example.invalid${path}` } as unknown as TransactionalMail;
  return { database, mail, send, queries };
}

describe('deliverBillingReceipt', () => {
  it('sends one receipt with the amount actually charged and the credit grant', async () => {
    const f = fixture();
    expect(await deliverBillingReceipt(f.database, f.mail, 'o1')).toEqual({ orderId: 'o1', sent: true });
    expect(f.send).toHaveBeenCalledWith(MAIL_TEMPLATE_KEYS.receipt, expect.objectContaining({ to: 'buyer@example.invalid', userId: 'u1', logMetadata: { orderId: 'o1' },
      data: expect.objectContaining({ amount: '20.00', currency: 'USD', discount: '—', credits: 7, paidAt: '2026-06-01 10:30 UTC', link: 'https://app.example.invalid/billing/orders' }) }));
    expect(f.queries[0].values).toEqual([MAIL_TEMPLATE_KEYS.receipt, 'o1']);
    expect(f.queries[0].sql).toContain('"email_logs"');
  });
  it('states the discounted payable, the discount and the list price', async () => {
    const f = fixture({ order: { offer: { description: 'Pro', money: { amount: '20.00', currency: 'USD' },
      promotion: { payable: { amount: '15.00', currency: 'USD' }, discount: { amount: '5.00', currency: 'USD' } } } }, owner: { locale: 'zh-CN' } });
    await deliverBillingReceipt(f.database, f.mail, 'o1', { credits: false });
    expect(((f.send.mock.calls[0] as unknown as unknown[])[1] as { data: unknown }).data).toMatchObject({ amount: '15.00', discount: '-5.00 USD (原价 20.00 USD)', credits: '—' });
  });
  it.each([
    ['unfulfilled order', { order: { fulfilledAt: null } }, 'not-fulfilled'],
    ['missing order', { order: null }, 'not-fulfilled'],
    ['already sent', { alreadySent: true }, 'already-sent'],
    ['unverified address', { owner: { emailVerified: false } }, 'no-recipient'],
    ['disabled account', { owner: { status: false } }, 'no-recipient'],
    ['no address', { owner: { email: null } }, 'no-recipient'],
    ['missing owner', { owner: null }, 'no-recipient'],
    ['mail disabled', { mailEnabled: false }, 'mail-disabled'],
  ] as const)('does not send for %s', async (_name, overrides, reason) => {
    const f = fixture(overrides as never);
    expect(await deliverBillingReceipt(f.database, f.mail, 'o1')).toEqual({ orderId: 'o1', sent: false, reason });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('throws on delivery failure so the job runner retries', async () => {
    const f = fixture({ sendOk: false });
    await expect(deliverBillingReceipt(f.database, f.mail, 'o1')).rejects.toThrow('Receipt mail delivery failed');
  });
});
