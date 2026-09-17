import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  createStripeCheckoutSession,
  retrieveStripeCheckoutSession,
  observeStripeCheckoutSession,
  observeStripePaymentIntent,
  retrieveStripePaymentIntent,
} from './stripe';
import { PayPalPaymentTransport, observePayPalOrder, decodePayPalWebhookEvent, decodePayPalMoneyReturnedEvent } from './paypal';

describe('hosted payment provider observations', () => {
  it('forwards the PayPal create request without constructing product fields or retrying', async () => {
    const raw = {
      id: 'pp',
      status: 'CREATED',
      links: [{ rel: 'approve', href: 'https://paypal.test/approve' }],
    };
    const orders = { createOrder: vi.fn().mockResolvedValue({ result: raw }) };
    const transport = Object.assign(
      Object.create(PayPalPaymentTransport.prototype) as PayPalPaymentTransport,
      { orders },
    );
    const input = {
      body: {
        intent: 'CAPTURE',
        purchaseUnits: [
          { referenceId: 'reference', amount: { currencyCode: 'USD', value: '12.34' } },
        ],
      },
    };
    const result = await transport.createOrder(input as never);
    expect(orders.createOrder).toHaveBeenCalledExactlyOnceWith(input);
    expect(orders.createOrder.mock.calls[0][0]).toBe(input);
    expect(result.raw).toBe(raw);
    expect(result.approveUrl).toBe('https://paypal.test/approve');
  });
  it('passes exact Checkout creation options once and retains untouched raw metadata', async () => {
    const raw = {
      id: 'cs',
      url: 'https://checkout.test/session',
      status: 'open',
      payment_status: 'unpaid',
      client_reference_id: 'reference',
      metadata: { privateProductField: 'value' },
      payment_intent: { id: 'pi' },
      subscription: null,
    } as unknown as Stripe.Checkout.Session;
    const params = {
      mode: 'payment',
      success_url: 'https://app.test/done',
      cancel_url: 'https://app.test/cancel',
      adaptive_pricing: { enabled: true },
      metadata: { privateProductField: 'value' },
    } as Stripe.Checkout.SessionCreateParams;
    const create = vi.fn().mockResolvedValue(raw);
    const client = { checkout: { sessions: { create } } };
    const observed = await createStripeCheckoutSession(client as never, params);
    expect(create).toHaveBeenCalledExactlyOnceWith(params);
    expect(create.mock.calls[0][0]).toBe(params);
    expect(observed.raw).toBe(raw);
    expect(observed).toMatchObject({
      id: 'cs',
      paymentIntentId: 'pi',
      clientReferenceId: 'reference',
      settlement: 'unknown',
    });
  });

  it('distinguishes paid evidence, expired sessions and nonterminal payment intents without writes', async () => {
    const raw = {
      id: 'cs',
      payment_status: 'unpaid',
      status: 'complete',
    } as Stripe.Checkout.Session;
    const retrieve = vi.fn().mockResolvedValue(raw);
    const create = vi.fn();
    const observed = await retrieveStripeCheckoutSession(
      { checkout: { sessions: { retrieve, create } } } as never,
      'cs',
    );
    expect(observed.settlement).toBe('unknown');
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledExactlyOnceWith('cs');
    expect(observeStripeCheckoutSession({ ...raw, status: 'expired' }).settlement).toBe('unpaid');
    expect(observeStripeCheckoutSession({ ...raw, payment_status: 'paid' }).settlement).toBe(
      'paid',
    );
    for (const status of ['processing', 'requires_action', 'requires_payment_method'] as const) {
      expect(
        observeStripePaymentIntent({
          id: 'pi',
          status,
          latest_charge: null,
        } as Stripe.PaymentIntent).settlement,
      ).toBe('unknown');
    }
  });

  it('normalizes expanded charge IDs and preserves explicit expansion without extra requests', async () => {
    const raw = {
      id: 'pi',
      status: 'succeeded',
      latest_charge: { id: 'charge', payment_method_details: { type: 'alipay' } },
    } as Stripe.PaymentIntent;
    const retrieve = vi.fn().mockResolvedValue(raw);
    const params = { expand: ['latest_charge'] };
    const observed = await retrieveStripePaymentIntent(
      { paymentIntents: { retrieve } } as never,
      'pi',
      params,
    );
    expect(retrieve).toHaveBeenCalledExactlyOnceWith('pi', params);
    expect(observed).toMatchObject({
      raw,
      chargeId: 'charge',
      paymentMethodType: 'alipay',
      settlement: 'paid',
    });
    expect(
      observeStripePaymentIntent({ ...raw, latest_charge: 'charge' }).paymentMethodType,
    ).toBeUndefined();
    expect(observeStripePaymentIntent({ ...raw, latest_charge: null }).chargeId).toBeNull();
  });

  it('preserves PayPal request arguments and never captures an APPROVED order during reads', async () => {
    const raw = {
      id: 'pp',
      status: 'APPROVED',
      links: [{ rel: 'approve', href: 'https://paypal.test/approve' }],
    };
    const orders = {
      getOrder: vi.fn().mockResolvedValue({ result: raw }),
      captureOrder: vi.fn(),
      createOrder: vi.fn(),
    };
    const transport = Object.assign(
      Object.create(PayPalPaymentTransport.prototype) as PayPalPaymentTransport,
      { orders },
    );
    const observed = await transport.getOrder({ id: 'pp' });
    expect(observed).toMatchObject({
      id: 'pp',
      approveUrl: 'https://paypal.test/approve',
      settlement: 'unknown',
    });
    expect(observed.raw).toBe(raw);
    expect(orders.getOrder).toHaveBeenCalledExactlyOnceWith({ id: 'pp' });
    expect(orders.captureOrder).not.toHaveBeenCalled();
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it('returns normalized capture evidence only for an explicitly requested capture', async () => {
    const raw = {
      id: 'pp',
      status: 'COMPLETED',
      purchaseUnits: [{ payments: { captures: [{ id: 'capture' }] } }],
    };
    const orders = { captureOrder: vi.fn().mockResolvedValue({ result: raw }) };
    const transport = Object.assign(
      Object.create(PayPalPaymentTransport.prototype) as PayPalPaymentTransport,
      { orders },
    );
    expect(await transport.captureOrder({ id: 'pp' })).toMatchObject({
      raw,
      captureId: 'capture',
      settlement: 'paid',
    });
    expect(orders.captureOrder).toHaveBeenCalledExactlyOnceWith({ id: 'pp' });
    expect(observePayPalOrder({ id: 'pp', status: 'VOIDED' }).settlement).toBe('unpaid');
    expect(observePayPalOrder({ id: 'pp', status: 'PAYER_ACTION_REQUIRED' }).settlement).toBe(
      'unknown',
    );
  });

  it('decodes standard capture events and rejects missing IDs before a consumer can query by them', () => {
    const event = {
      event_type: 'PAYMENT.CAPTURE.DENIED',
      resource: { id: 'capture', status_details: { reason: 'DECLINED' } },
    };
    expect(decodePayPalWebhookEvent(JSON.stringify(event))).toMatchObject({
      type: event.event_type,
      kind: 'capture-failed',
      capture: { id: 'capture', failureReason: 'DECLINED', raw: event.resource },
    });
    expect(() =>
      decodePayPalWebhookEvent('{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{}}'),
    ).toThrow('resource ID');
    expect(decodePayPalWebhookEvent('{"event_type":"UNHANDLED"}').kind).toBe('unknown');
  });
});

describe('PayPal money-returned event contracts', () => {
  it('resolves a standard v2 Refund resource through its capture up link', () => {
    const event = decodePayPalMoneyReturnedEvent(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: {
      id: 'refund', status: 'COMPLETED', amount: { value: '10.99', currency_code: 'USD' },
      links: [{ rel: 'self', href: 'https://api-m.paypal.com/v2/payments/refunds/refund' }, { rel: 'up', href: 'https://api-m.paypal.com/v2/payments/captures/CAPTURE123' }],
    } }));
    expect(event).toMatchObject({ kind: 'capture-refunded', returned: { id: 'refund', captureId: 'CAPTURE123', amount: '10.99', currency: 'USD', status: 'COMPLETED' } });
  });
  it('uses the capture resource itself for reversals', () => {
    expect(decodePayPalMoneyReturnedEvent(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.REVERSED', resource: {
      id: 'CAPTURE123', amount: { value: '10.99', currency_code: 'USD' },
    } }))).toMatchObject({ kind: 'capture-reversed', returned: { id: 'reversal:CAPTURE123', captureId: 'CAPTURE123', status: 'COMPLETED' } });
  });
  it('does not trust an arbitrary up URL or a missing amount', () => {
    const resource = { id: 'refund', status: 'COMPLETED', amount: { value: '10.99', currency_code: 'USD' }, links: [{ rel: 'up', href: 'https://evil.example/v2/payments/captures/CAPTURE123' }] };
    expect(() => decodePayPalMoneyReturnedEvent(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource }))).toThrow('identity');
    expect(() => decodePayPalMoneyReturnedEvent(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { ...resource, amount: null } }))).toThrow('Invalid');
  });
});

it('keeps refund events unknown to the legacy capture decoder', () => {
  expect(decodePayPalWebhookEvent(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.REFUNDED' }))).toMatchObject({ kind: 'unknown' });
});
