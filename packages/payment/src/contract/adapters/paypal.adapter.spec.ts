import { describe, expect, it, vi } from 'vitest';
import type { Order as PayPalOrder } from '@paypal/paypal-server-sdk';
import type { PayPalPaymentTransport } from '../../providers/paypal';
import { createPayPalAdapter } from './paypal.adapter';

function fixture(
  raw: unknown = {
    id: 'order-1',
    status: 'COMPLETED',
    purchaseUnits: [
      {
        amount: { value: '10.00', currencyCode: 'USD' },
        payments: {
          captures: [
            {
              id: 'capture-1',
              status: 'COMPLETED',
              amount: { value: '10.00', currencyCode: 'USD' },
            },
          ],
        },
      },
    ],
  },
) {
  const observation = { raw: raw as PayPalOrder };
  const transport = {
    getOrder: vi.fn().mockResolvedValue(observation),
    createOrder: vi.fn().mockResolvedValue(observation),
    captureOrder: vi.fn().mockResolvedValue(observation),
    refundCapture: vi.fn().mockResolvedValue({ id: 'refund-1', status: 'COMPLETED' }),
    verifyWebhookSignature: vi.fn(),
  };
  return {
    transport,
    adapter: createPayPalAdapter({ transport: transport as unknown as PayPalPaymentTransport }),
  };
}
const input = {
  providerRef: 'order-1',
  idempotencyKey: 'refund-key',
  money: { amount: '2.00', currency: 'USD' },
  reason: 'Synthetic refund',
};
describe('legacy PayPal order-to-capture refund reference', () => {
  it('keeps order references in every PaymentSession and resolves the capture only for refund', async () => {
    const { adapter, transport } = fixture();
    const created = await adapter.createPayment({
      reference: 'merchant-order',
      money: { amount: '10.00', currency: 'USD' },
      idempotencyKey: 'create-key',
    });
    const captured = await adapter.capture(created.providerRef, 'capture-key');
    const retrieved = await adapter.retrieve(captured.providerRef);
    expect([created.providerRef, captured.providerRef, retrieved.providerRef]).toEqual([
      'order-1',
      'order-1',
      'order-1',
    ]);
    await expect(adapter.refund(input)).resolves.toEqual({
      refundRef: 'refund-1',
      state: 'refunded',
    });
    expect(transport.getOrder).toHaveBeenLastCalledWith({ id: 'order-1' });
    expect(transport.refundCapture).toHaveBeenCalledExactlyOnceWith(
      'capture-1',
      { amount: { value: '2.00', currency_code: 'USD' }, note_to_payer: 'Synthetic refund' },
      'refund-key',
    );
    expect(transport.captureOrder).toHaveBeenCalledOnce();
  });
  it('supports the unique partially-refunded capture without inventing a remaining balance', async () => {
    const { adapter, transport } = fixture({
      id: 'order-1',
      status: 'COMPLETED',
      purchaseUnits: [
        {
          payments: {
            captures: [
              {
                id: 'capture-partial',
                status: 'PARTIALLY_REFUNDED',
                amount: { value: '10.00', currencyCode: 'USD' },
              },
            ],
          },
        },
      ],
    });
    await adapter.refund({ providerRef: 'order-1', idempotencyKey: 'remaining' });
    expect(transport.refundCapture).toHaveBeenCalledExactlyOnceWith(
      'capture-partial',
      { note_to_payer: undefined },
      'remaining',
    );
    expect(transport.captureOrder).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'other-order', purchaseUnits: [] },
    { id: 'order-1', purchaseUnits: [] },
    {
      id: 'order-1',
      purchaseUnits: [{ payments: { captures: [{ id: 'pending', status: 'PENDING' }] } }],
    },
    {
      id: 'order-1',
      purchaseUnits: [{ payments: { captures: [{ id: 'refunded', status: 'REFUNDED' }] } }],
    },
    { id: 'order-1', purchaseUnits: [{ payments: { captures: [{ status: 'COMPLETED' }] } }] },
    {
      id: 'order-1',
      purchaseUnits: [
        {
          payments: {
            captures: [
              {
                id: 'capture-1',
                status: 'COMPLETED',
                amount: { value: '10.00', currencyCode: 'USD' },
              },
            ],
          },
        },
        {
          payments: {
            captures: [
              {
                id: 'capture-2',
                status: 'COMPLETED',
                amount: { value: '1.00', currencyCode: 'USD' },
              },
            ],
          },
        },
      ],
    },
  ])(
    'refuses mismatched or ambiguous order evidence without a refund mutation (%j)',
    async (raw) => {
      const { adapter, transport } = fixture(raw);
      await expect(adapter.refund(input)).rejects.toThrow();
      expect(transport.refundCapture).not.toHaveBeenCalled();
      expect(transport.captureOrder).not.toHaveBeenCalled();
    },
  );
  it.each([
    { amount: '2.00', currency: 'EUR' },
    { amount: '10.01', currency: 'USD' },
    { amount: '0', currency: 'USD' },
    { amount: '-1', currency: 'USD' },
    { amount: '0.001', currency: 'USD' },
  ])('validates the requested amount against the actual capture (%j)', async (money) => {
    const { adapter, transport } = fixture();
    await expect(adapter.refund({ ...input, money })).rejects.toThrow();
    expect(transport.refundCapture).not.toHaveBeenCalled();
  });
  it('never treats a failed order lookup as permission to send an untyped reference directly to refundCapture', async () => {
    const { adapter, transport } = fixture();
    transport.getOrder.mockRejectedValueOnce(new Error('order not found'));
    await expect(adapter.refund({ ...input, providerRef: 'a-capture-id' })).rejects.toThrow(
      'order not found',
    );
    expect(transport.refundCapture).not.toHaveBeenCalled();
  });
});

describe('legacy PayPal webhook refund mapping (M3)', () => {
  const refundEvent = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'refund-1', supplementary_data: { related_ids: { order_id: 'order-1' } } } });
  function webhookFixture(captureStatus: string) {
    const { transport } = fixture({ id: 'order-1', status: 'COMPLETED',
      purchaseUnits: [{ payments: { captures: [{ id: 'capture-1', status: captureStatus }] } }] });
    transport.verifyWebhookSignature.mockResolvedValue(true);
    const adapter = createPayPalAdapter({ transport: transport as unknown as PayPalPaymentTransport, webhookId: 'wh' });
    return adapter.parseWebhook({ headers: {}, rawBody: refundEvent });
  }
  it('reports a partial refund as partially_refunded, not refunded', async () => {
    await expect(webhookFixture('PARTIALLY_REFUNDED')).resolves.toMatchObject({ providerRef: 'order-1', state: 'partially_refunded' });
  });
  it('reports refunded only when the capture itself is fully refunded', async () => {
    await expect(webhookFixture('REFUNDED')).resolves.toMatchObject({ state: 'refunded' });
    await expect(webhookFixture('COMPLETED')).resolves.toMatchObject({ state: 'unknown' });
  });
});

describe('legacy PayPal refund webhook without supplementary_data (N16)', () => {
  const upLink = { rel: 'up', href: 'https://api-m.paypal.com/v2/payments/captures/CAP1' };
  const event = (links?: unknown) => JSON.stringify({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'refund-1', ...(links ? { links } : {}) } });
  function setup(captureStatus = 'PARTIALLY_REFUNDED') {
    const { transport } = fixture({ id: 'order-1', status: 'COMPLETED',
      purchaseUnits: [{ payments: { captures: [{ id: 'CAP1', status: captureStatus }] } }] });
    const withCapture = Object.assign(transport, {
      getCapturePayment: vi.fn().mockResolvedValue({ id: 'CAP1', supplementary_data: { related_ids: { order_id: 'order-1' } } }),
    });
    withCapture.verifyWebhookSignature.mockResolvedValue(true);
    const adapter = createPayPalAdapter({ transport: withCapture as unknown as PayPalPaymentTransport, webhookId: 'wh' });
    return { adapter, transport: withCapture };
  }

  it('resolves the order through the up link and derives the state from the capture status', async () => {
    const { adapter, transport } = setup('PARTIALLY_REFUNDED');
    await expect(adapter.parseWebhook({ headers: {}, rawBody: event([upLink]) }))
      .resolves.toMatchObject({ providerRef: 'order-1', state: 'partially_refunded' });
    expect(transport.getCapturePayment).toHaveBeenCalledExactlyOnceWith('CAP1');
    expect(transport.getOrder).toHaveBeenCalledWith({ id: 'order-1' });
    const full = setup('REFUNDED');
    await expect(full.adapter.parseWebhook({ headers: {}, rawBody: event([upLink]) })).resolves.toMatchObject({ providerRef: 'order-1', state: 'refunded' });
  });

  it('reports unknown when the capture lookup fails', async () => {
    const { adapter, transport } = setup();
    transport.getCapturePayment.mockRejectedValueOnce(new Error('404'));
    const result = await adapter.parseWebhook({ headers: {}, rawBody: event([upLink]) });
    expect(result.state).toBe('unknown');
    expect(result.providerRef).toBeUndefined();
    expect(transport.getOrder).not.toHaveBeenCalled();
  });

  it('reports unknown without any lookup when there is no up link', async () => {
    const { adapter, transport } = setup();
    for (const links of [undefined, [], [{ rel: 'self', href: 'https://api-m.paypal.com/v2/payments/refunds/refund-1' }]]) {
      const result = await adapter.parseWebhook({ headers: {}, rawBody: event(links) });
      expect(result.state).toBe('unknown');
    }
    expect(transport.getCapturePayment).not.toHaveBeenCalled();
  });
});
