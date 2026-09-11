import { describe, expect, it } from 'vitest';
import { createStripeClient, verifyStripeWebhookEvent } from './stripe';

describe('Stripe transport primitives', () => {
  it('verifies the original webhook bytes and rejects a modified payload', () => {
    const client = createStripeClient('sk_test_synthetic', { apiVersion: '2026-08-26.dahlia' });
    const payload = JSON.stringify({
      id: 'evt_synthetic',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_synthetic' } },
    });
    const secret = 'whsec_synthetic';
    const signature = client.webhooks.generateTestHeaderString({ payload, secret });
    expect(verifyStripeWebhookEvent(client, Buffer.from(payload), signature, secret).id).toBe(
      'evt_synthetic',
    );
    expect(() =>
      verifyStripeWebhookEvent(client, Buffer.from(payload + ' '), signature, secret),
    ).toThrow();
    expect(() => verifyStripeWebhookEvent(client, payload, signature, 'whsec_wrong')).toThrow();
  });
});
