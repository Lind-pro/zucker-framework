import { HostedCheckoutService } from './service';
import { HostedCheckoutError, type HostedCheckoutAdapter, type HostedCheckoutObservation, type HostedCheckoutOffer, type HostedCheckoutOrder,
  type HostedCheckoutPersistence, type HostedCheckoutProviderResolver } from './types';
import type { OrderPersistence } from '../order-persistence';

const selection = { orderId: 'order-1', ownerId: 'user-1', offerId: 'offer-1', providerId: 'synthetic' };
const offer: HostedCheckoutOffer = { version: 'v1', catalogReference: 'catalog-1', mode: 'payment', money: { amount: '29.00', currency: 'USD' }, description: 'Synthetic offer' };
const observed = (changes: Partial<HostedCheckoutObservation> = {}): HostedCheckoutObservation => ({
  checkoutId: 'checkout-1', reference: selection.orderId, catalogReference: offer.catalogReference, mode: 'payment', quantity: 1, state: 'paid',
  paidMoney: { amount: '29', currency: 'USD' }, dueMoney: offer.money, paymentId: 'payment-1', paymentKind: 'capture', ...changes,
});

/** An adapter whose webhook verification succeeds only for its own synthetic secret. */
function adapter(name: string, accountScope: string): HostedCheckoutAdapter & { name: string } {
  return { name, id: 'synthetic', accountScope, modes: ['payment'], validate: vi.fn(),
    create: vi.fn(async () => observed({ state: 'pending', url: 'https://checkout.example/1' })),
    retrieve: vi.fn(async () => observed()),
    verifyWebhook: vi.fn(async (request: { headers: Record<string, string> }) => {
      if (request.headers.secret !== name) throw new HostedCheckoutError('verification_failed', `signature invalid for ${name}`);
      return { eventId: 'event-1', checkoutId: 'checkout-1', reference: request.headers.reference ?? selection.orderId };
    }) } as never;
}

function fixture() {
  const rows = new Map<string, HostedCheckoutOrder>(), fulfilled: string[] = [];
  const matches = (row: HostedCheckoutOrder, expected: Record<string, unknown>) => Object.entries(expected).every(([key, value]) => row[key as keyof HostedCheckoutOrder] === value);
  const store: OrderPersistence<HostedCheckoutOrder> = {
    create: vi.fn(async ({ data }) => { const row = data as HostedCheckoutOrder; if (rows.has(row.id)) throw new Error('Duplicate'); rows.set(row.id, structuredClone(row)); return structuredClone(row); }),
    findUnique: vi.fn(async ({ where }) => structuredClone(rows.get((where as { id: string }).id) ?? null)),
    findMany: vi.fn(async args => [...rows.values()].filter(row => matches(row, args?.where as Record<string, unknown> ?? {})).map(row => structuredClone(row))),
    count: vi.fn(async () => rows.size), update: vi.fn(), updateMany: vi.fn(),
    compareAndSet: vi.fn(async (id, expected, data) => { const row = rows.get(id); if (!row || !matches(row, expected)) return false; rows.set(id, { ...row, ...structuredClone(data) } as HostedCheckoutOrder); return true; }),
  };
  const persistence: HostedCheckoutPersistence = { orders: store, transaction: work => work({ orders: store, fulfill: async order => { fulfilled.push(order.id); } }) };
  // Credentials keyed by revision: r1 and r2 are account A (key rotation), r3 is account B.
  const revisions: Record<number, ReturnType<typeof adapter>> = { 1: adapter('r1', 'account-a'), 2: adapter('r2', 'account-a'), 3: adapter('r3', 'account-b') };
  const state = { current: 1, retained: [1] as number[] };
  const resolver: HostedCheckoutProviderResolver = {
    ids: async () => ['synthetic'],
    current: async () => ({ adapter: revisions[state.current], configRevision: `synthetic@${state.current}` }),
    forOrder: async order => {
      const min = Number(/^synthetic@(\d+)$/.exec(order.configRevision ?? '')?.[1]);
      if (!min) throw new HostedCheckoutError('verification_failed', 'Recorded configuration revision is invalid');
      const match = [...state.retained].sort((a, b) => b - a).find(revision => revision >= min && revisions[revision].accountScope === order.accountScope);
      if (match === undefined) throw new HostedCheckoutError('verification_failed', 'No credentials of this order account are retained');
      return revisions[match];
    },
    webhookCandidates: async () => [...state.retained].sort((a, b) => b - a).map(revision => revisions[revision]),
  };
  const service = new HostedCheckoutService({ persistence, providers: resolver, resolveOffer: async () => structuredClone(offer),
    returnUrls: () => ({ successUrl: 'https://app.example/return', cancelUrl: 'https://app.example/cancel' }) });
  const rotate = (revision: number) => { state.current = revision; state.retained.push(revision); };
  return { service, rows, revisions, state, rotate, fulfilled, store };
}

describe('hosted checkout with a provider resolver', () => {
  it('records the current revision on a new order and dispatches with the adapter captured for it', async () => {
    const f = fixture();
    const order = await f.service.create(selection);
    expect(order.configRevision).toBe('synthetic@1');
    expect(f.revisions[1].create).toHaveBeenCalledOnce();
    // A configuration change after creation never rewrites the recorded revision.
    f.rotate(2);
    await f.service.confirm(selection);
    expect(f.rows.get('order-1')?.configRevision).toBe('synthetic@1');
  });

  it('rotation inside one account: an existing order confirms with the newest key of its account, once', async () => {
    const f = fixture();
    await f.service.create(selection);
    f.rotate(2);
    await f.service.confirm(selection);
    await f.service.confirm(selection);
    expect(f.revisions[2].retrieve).toHaveBeenCalledOnce();
    expect(f.revisions[1].retrieve).not.toHaveBeenCalled();
    expect(f.fulfilled).toEqual(['order-1']);
  });

  it('switch to another account: old orders stay on their account; new orders use the new one', async () => {
    const f = fixture();
    await f.service.create(selection);
    f.rotate(3);
    await f.service.confirm(selection);
    expect(f.revisions[1].retrieve).toHaveBeenCalledOnce();
    expect(f.revisions[3].retrieve).not.toHaveBeenCalled();
    vi.mocked(f.revisions[3].create).mockResolvedValueOnce(observed({ checkoutId: 'checkout-2', reference: 'order-2', state: 'pending', url: 'https://checkout.example/2' }));
    const next = await f.service.create({ ...selection, orderId: 'order-2' });
    expect(next).toMatchObject({ accountScope: 'account-b', configRevision: 'synthetic@3' });
    expect(f.revisions[3].create).toHaveBeenCalledOnce();
  });

  it('verifies a webhook signed with a retained older secret and settles its order once', async () => {
    const f = fixture();
    await f.service.create(selection);
    f.rotate(2);
    const request = { rawBody: '{}', headers: { secret: 'r1' } };
    await f.service.webhook('synthetic', request);
    await f.service.webhook('synthetic', request);
    // Newest candidate first: r2 refused, r1 verified; the order is re-read through its newest same-account key.
    expect(f.revisions[2].verifyWebhook).toHaveBeenCalledTimes(2);
    expect(f.revisions[1].verifyWebhook).toHaveBeenCalledTimes(2);
    expect(f.revisions[2].retrieve).toHaveBeenCalledTimes(2);
    expect(f.revisions[1].retrieve).not.toHaveBeenCalled();
    expect(f.fulfilled).toEqual(['order-1']);
  });

  it('refuses a webhook verified for another account than the order, with no state change', async () => {
    const f = fixture();
    await f.service.create(selection);
    f.rotate(3);
    const before = structuredClone(f.rows.get('order-1'));
    await expect(f.service.webhook('synthetic', { rawBody: '{}', headers: { secret: 'r3' } })).rejects.toThrow('Webhook account does not match the order');
    expect(f.rows.get('order-1')).toEqual(before);
    expect(f.revisions[1].retrieve).not.toHaveBeenCalled(); expect(f.revisions[3].retrieve).not.toHaveBeenCalled();
  });

  it('settles through the order account when another account shares the signing secret', async () => {
    const f = fixture();
    await f.service.create(selection);
    f.rotate(3);
    // Account B (newest) verifies the same signature; the order belongs to account A, so A must verify it too.
    vi.mocked(f.revisions[3].verifyWebhook).mockResolvedValue({ eventId: 'event-1', checkoutId: 'checkout-1', reference: selection.orderId });
    await f.service.webhook('synthetic', { rawBody: '{}', headers: { secret: 'r1' } });
    expect(f.revisions[1].retrieve).toHaveBeenCalledOnce(); expect(f.revisions[3].retrieve).not.toHaveBeenCalled();
    expect(f.fulfilled).toEqual(['order-1']);
  });

  it('reports the newest candidate refusal when no candidate verifies', async () => {
    const f = fixture();
    await f.service.create(selection);
    f.rotate(2);
    await expect(f.service.webhook('synthetic', { rawBody: '{}', headers: { secret: 'forged' } })).rejects.toThrow('signature invalid for r2');
  });

  it('tries at most eight candidates', async () => {
    const f = fixture();
    const many = Array.from({ length: 12 }, (_, index) => adapter(`c${index}`, 'account-a'));
    const service = new HostedCheckoutService({ persistence: { orders: f.store, transaction: work => work({ orders: f.store, fulfill: async () => undefined }) },
      providers: { ids: async () => ['synthetic'], current: async () => undefined, forOrder: async () => undefined, webhookCandidates: async () => many },
      resolveOffer: async () => structuredClone(offer), returnUrls: () => ({ successUrl: 'https://app.example/r', cancelUrl: 'https://app.example/c' }) });
    await expect(service.webhook('synthetic', { rawBody: '{}', headers: { secret: 'c9' } })).rejects.toThrow('signature invalid for c0');
    expect(many.slice(0, 8).every(candidate => vi.mocked(candidate.verifyWebhook).mock.calls.length === 1)).toBe(true);
    expect(many.slice(8).every(candidate => vi.mocked(candidate.verifyWebhook).mock.calls.length === 0)).toBe(true);
  });

  it('refuses an order whose recorded revision was forged, without contacting a provider or changing state', async () => {
    const f = fixture();
    await f.service.create(selection);
    f.rotate(3);
    for (const forged of ['synthetic@3', 'synthetic@0', 'garbage', null]) {
      f.rows.set('order-1', { ...f.rows.get('order-1')!, configRevision: forged });
      await expect(f.service.confirm(selection)).rejects.toMatchObject({ code: 'verification_failed' });
    }
    expect(f.revisions[1].retrieve).not.toHaveBeenCalled(); expect(f.revisions[3].retrieve).not.toHaveBeenCalled();
    expect(f.fulfilled).toEqual([]);
  });

  it('refuses a resolver adapter of another account even if the resolver returns one', async () => {
    const f = fixture();
    await f.service.create(selection);
    const service = new HostedCheckoutService({ persistence: { orders: f.store, transaction: work => work({ orders: f.store, fulfill: async () => undefined }) },
      providers: { ids: async () => ['synthetic'], current: async () => undefined, forOrder: async () => f.revisions[3], webhookCandidates: async () => [] },
      resolveOffer: async () => structuredClone(offer), returnUrls: () => ({ successUrl: 'https://app.example/r', cancelUrl: 'https://app.example/c' }) });
    await expect(service.confirm(selection)).rejects.toThrow('Provider account scope changed');
    await expect(service.create({ ...selection, orderId: 'order-9' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(service.webhook('synthetic', { rawBody: '{}', headers: {} })).rejects.toMatchObject({ code: 'unsupported' });
  });
});
