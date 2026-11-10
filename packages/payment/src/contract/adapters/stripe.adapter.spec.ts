import type Stripe from 'stripe';
import { createStripeAdapter } from './stripe.adapter';

function adapterFor(charge: Partial<Stripe.Charge>, sessions: Array<{ id: string }>) {
  const list = vi.fn(async () => ({ data: sessions }));
  const client = {
    webhooks: { constructEvent: vi.fn(() => ({ id: 'evt', type: 'charge.refunded', data: { object: charge } })) },
    checkout: { sessions: { list } },
  } as unknown as Stripe;
  return { adapter: createStripeAdapter({ client, webhookSecret: 'whsec' }), list };
}
const request = { headers: { 'stripe-signature': 'sig' }, rawBody: '{}' };

describe('legacy Stripe webhook refund mapping (M3)', () => {
  it('maps a partial charge refund to partially_refunded and correlates the Checkout Session', async () => {
    const { adapter, list } = adapterFor({ id: 'ch_1', refunded: false, amount_refunded: 500, payment_intent: 'pi_1' }, [{ id: 'cs_1' }]);
    await expect(adapter.parseWebhook(request)).resolves.toMatchObject({ providerRef: 'cs_1', state: 'partially_refunded' });
    expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 2 });
  });
  it('maps a full refund to refunded and never uses the charge ID as providerRef', async () => {
    const { adapter } = adapterFor({ id: 'ch_1', refunded: true, amount_refunded: 2900, payment_intent: 'pi_1' }, []);
    const observation = await adapter.parseWebhook(request);
    expect(observation).toMatchObject({ state: 'refunded' });
    expect(observation.providerRef).toBeUndefined();
  });
});
