import { HostedCheckoutService } from './service';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOffer, HostedCheckoutOrder, HostedCheckoutPersistence } from './types';
import type { OrderPersistence } from '../order-persistence';

const selection = { orderId: 'order-1', ownerId: 'user-1', offerId: 'offer-1', providerId: 'synthetic' };
const offer: HostedCheckoutOffer = { version: 'v1', catalogReference: 'catalog-1', mode: 'payment',
  money: { amount: '29.00', currency: 'USD' }, description: 'Synthetic offer' };
const observed = (changes: Partial<HostedCheckoutObservation> = {}): HostedCheckoutObservation => ({
  checkoutId: 'checkout-1', reference: selection.orderId, catalogReference: offer.catalogReference,
  mode: 'payment', quantity: 1, state: 'paid', paidMoney: { amount: '29', currency: 'USD' },
  dueMoney: offer.money, paymentId: 'payment-1', paymentKind: 'capture', ...changes,
});

/** Serial rollback-capable port fake; not evidence of PostgreSQL isolation or durability. */
function fixture() {
  let rows = new Map<string, HostedCheckoutOrder>();
  let fulfilled: string[] = [];
  let fulfilledOrders: HostedCheckoutOrder[] = [];
  let failFulfillment = false;
  const matches = (row: HostedCheckoutOrder, expected: Record<string, unknown>) =>
    Object.entries(expected).every(([key, value]) => row[key as keyof HostedCheckoutOrder] === value);
  const store: OrderPersistence<HostedCheckoutOrder> = {
    create: vi.fn(async ({ data }) => {
      const row = data as HostedCheckoutOrder;
      if (rows.has(row.id)) throw new Error('Duplicate order');
      rows.set(row.id, structuredClone(row)); return structuredClone(row);
    }),
    findUnique: vi.fn(async ({ where }) => structuredClone(rows.get((where as { id: string }).id) ?? null)),
    findMany: vi.fn(async (args) => [...rows.values()].filter((row) => matches(row, args?.where as Record<string, unknown> ?? {})).map((row) => structuredClone(row))),
    count: vi.fn(async () => rows.size), update: vi.fn(), updateMany: vi.fn(),
    compareAndSet: vi.fn(async (id, expected, data) => {
      const row = rows.get(id);
      if (!row || !matches(row, expected)) return false;
      rows.set(id, { ...row, ...structuredClone(data) } as HostedCheckoutOrder); return true;
    }),
  };
  let tail = Promise.resolve();
  const persistence: HostedCheckoutPersistence = { orders: store,
    async transaction(work) {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await before;
      const oldRows = structuredClone(rows), oldFulfilled = [...fulfilled], oldFulfilledOrders = structuredClone(fulfilledOrders);
      try {
        return await work({ orders: store, fulfill: async (order) => {
          fulfilled.push(order.id);
          fulfilledOrders.push(structuredClone(order));
          if (failFulfillment) throw new Error('Entitlement write failed');
        } });
      } catch (error) { rows = oldRows; fulfilled = oldFulfilled; fulfilledOrders = oldFulfilledOrders; throw error; }
      finally { release(); }
    },
  };
  const adapter: HostedCheckoutAdapter = {
    id: 'synthetic', accountScope: 'test-merchant', modes: ['payment', 'subscription'], supportsMetadata: true, validate: vi.fn(),
    create: vi.fn(async () => observed({ state: 'pending', url: 'https://checkout.example/1' })),
    retrieve: vi.fn(async () => observed()), capture: vi.fn(async () => observed()),
    verifyWebhook: vi.fn(async () => ({ eventId: 'event-1', checkoutId: 'checkout-1', reference: selection.orderId })),
  };
  const resolveOffer = vi.fn(async (_selection: Readonly<typeof selection>) => structuredClone(offer));
  const options = { persistence, providers: [adapter], resolveOffer,
    returnUrls: () => ({ successUrl: 'https://app.example/return', cancelUrl: 'https://app.example/cancel' }) };
  return { service: new HostedCheckoutService(options), options, store, adapter, resolveOffer,
    fulfilled: () => fulfilled, fulfilledOrders: () => fulfilledOrders, failFulfillment: (fail: boolean) => { failFulfillment = fail; } };
}

describe('hosted checkout durable initial fulfillment', () => {
  it('prepares verified paid facts outside the transaction and leaves delivery retryable on preparation failure', async () => {
    const f = fixture(); await f.service.create(selection);
    const transaction = vi.spyOn(f.options.persistence, 'transaction');
    const prepareFulfillment = vi.fn(async (order: Readonly<HostedCheckoutOrder>, payment: Readonly<HostedCheckoutObservation>): Promise<void> => {
      expect(transaction).not.toHaveBeenCalled();
      expect(order).toMatchObject({ id: selection.orderId, ownerId: selection.ownerId, fulfilledAt: null });
      expect(payment).toMatchObject({ paymentId: 'payment-1', paymentKind: 'capture', paidMoney: { amount: '29', currency: 'USD' } });
      throw new Error('Refund evidence unavailable');
    });
    const service = new HostedCheckoutService({ ...f.options, prepareFulfillment });
    await expect(service.confirm(selection)).rejects.toThrow('Refund evidence unavailable');
    expect(f.fulfilled()).toEqual([]); expect(transaction).not.toHaveBeenCalled();
    expect((await service.get(selection.orderId, selection.ownerId)).fulfilledAt).toBeNull();
    prepareFulfillment.mockImplementationOnce(async () => {});
    await service.confirm(selection); expect(f.fulfilled()).toEqual([selection.orderId]);
  });

  it('does not prepare mismatched, unpaid or incomplete payment observations', async () => {
    const f = fixture(); await f.service.create(selection); const prepareFulfillment = vi.fn(async () => {});
    const service = new HostedCheckoutService({ ...f.options, prepareFulfillment });
    f.adapter.retrieve = vi.fn(async () => observed({ paidMoney: { amount: '100', currency: 'USD' } }));
    await expect(service.confirm(selection)).rejects.toThrow('Paid amount');
    f.adapter.retrieve = vi.fn(async () => observed({ reference: 'foreign-order' }));
    await expect(service.confirm(selection)).rejects.toThrow('reference');
    f.adapter.retrieve = vi.fn(async () => observed({ state: 'pending' })); await service.confirm(selection);
    f.adapter.retrieve = vi.fn(async () => observed({ paymentId: undefined })); await service.confirm(selection);
    expect(prepareFulfillment).not.toHaveBeenCalled(); expect(f.fulfilled()).toEqual([]);
  });

  it('isolates preparation snapshots from the later persisted owner, policy and payment identity', async () => {
    const f = fixture(); await f.service.create(selection);
    const prepareFulfillment = vi.fn(async (order: Readonly<HostedCheckoutOrder>, payment: Readonly<HostedCheckoutObservation>) => {
      Object.assign(order, { ownerId: 'foreign-owner' }); order.offer.money.amount = '999';
      Object.assign(payment, { paymentId: 'foreign-payment' }); if (payment.paidMoney) payment.paidMoney.amount = '999';
    });
    const service = new HostedCheckoutService({ ...f.options, prepareFulfillment });
    expect(await service.confirm(selection)).toMatchObject({ ownerId: selection.ownerId, paymentId: 'payment-1', offer });
    expect(f.fulfilledOrders()[0]).toMatchObject({ ownerId: selection.ownerId, paymentId: 'payment-1', offer });
  });

  it('requires persistence and validates all input before provider dispatch', async () => {
    const f = fixture();
    expect(() => new HostedCheckoutService({ ...f.options, persistence: undefined as never })).toThrow('persistence');
    await expect(f.service.create({ ...selection, ownerId: '' })).rejects.toThrow('ownerId');
    f.resolveOffer.mockResolvedValueOnce({ ...offer, money: { amount: '0', currency: 'USD' } });
    await expect(f.service.create(selection)).rejects.toThrow('positive');
    expect(f.adapter.create).not.toHaveBeenCalled();
  });

  it('refuses a provider price that drifted from the offer before any order or payable checkout exists', async () => {
    const f = fixture();
    const quote = vi.fn(async () => ({ money: { amount: '25.00', currency: 'USD' }, mode: 'payment' as const }));
    const service = new HostedCheckoutService({ ...f.options, providers: [{ ...f.adapter, quote }] });
    await expect(service.create(selection)).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('provider price') });
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ catalogReference: 'catalog-1', money: offer.money }));
    expect(quote.mock.calls[0]).not.toHaveProperty('0.fulfillmentData');
    expect(f.store.create).not.toHaveBeenCalled();
    expect(f.adapter.create).not.toHaveBeenCalled();
    quote.mockResolvedValueOnce({ money: { amount: '29', currency: 'USD' }, mode: 'subscription' as const });
    await expect(service.create(selection)).rejects.toMatchObject({ code: 'conflict' });
    // Equal money (any notation) or an unknown provider price proceeds.
    quote.mockResolvedValueOnce({ money: { amount: '29', currency: 'USD' }, mode: 'payment' as const });
    expect(await service.create(selection)).toMatchObject({ creationState: 'created' });
    const unknown = fixture();
    const silent = new HostedCheckoutService({ ...unknown.options, providers: [{ ...unknown.adapter, quote: vi.fn(async () => null) }] });
    expect(await silent.create(selection)).toMatchObject({ creationState: 'created' });
  });

  it('persists owner, immutable quote and stable keys before contacting provider', async () => {
    const f = fixture();
    vi.mocked(f.adapter.create).mockImplementation(async (order) => {
      expect(await f.service.get(order.id, selection.ownerId)).toMatchObject({ creationState: 'submitting', offer });
      return observed({ state: 'pending' });
    });
    const first = await f.service.create(selection);
    f.resolveOffer.mockResolvedValue({ ...offer, version: 'v2', money: { amount: '99', currency: 'USD' } });
    const restarted = new HostedCheckoutService(f.options);
    expect((await restarted.create(selection)).offer).toEqual(offer);
    expect(first.createKey).toHaveLength(37);
    expect(f.resolveOffer).toHaveBeenCalledOnce();
    expect(f.adapter.create).toHaveBeenCalledOnce();
    await expect(restarted.create({ ...selection, offerId: 'other-offer' })).rejects.toThrow('selection');
  });

  it('snapshots selection before awaiting and freezes the catalog callback input', async () => {
    const f = fixture(); const input = { ...selection };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.resolveOffer.mockImplementation(async (received) => {
      expect(Object.isFrozen(received)).toBe(true);
      expect(Reflect.set(received, 'ownerId', 'catalog-rebind')).toBe(false);
      entered(); await gate; return structuredClone(offer);
    });
    const pending = f.service.create(input);
    await started;
    Object.assign(input, { orderId: 'other-order', ownerId: 'other-owner', offerId: 'other-offer', providerId: 'other-provider' });
    release();
    expect(await pending).toMatchObject({ id: selection.orderId, ownerId: selection.ownerId,
      offerId: selection.offerId, providerId: selection.providerId });
  });

  it('fulfills the frozen private policy after the catalog changes and never exposes it to providers', async () => {
    const f = fixture();
    const policy = { credits: 100, expiresInDays: 30, nested: { buckets: ['initial', null, true] } };
    f.resolveOffer.mockResolvedValue({ ...offer, fulfillmentData: policy });
    await f.service.create(selection);
    expect(vi.mocked(f.adapter.validate).mock.calls[0]?.[0].fulfillmentData).toBeUndefined();
    expect(vi.mocked(f.adapter.create).mock.calls[0]?.[0].offer.fulfillmentData).toBeUndefined();
    policy.credits = 999; policy.nested.buckets[0] = 'changed';
    f.resolveOffer.mockResolvedValue({ ...offer, version: 'v2', fulfillmentData: { credits: 500, expiresInDays: 1 } });
    await new HostedCheckoutService(f.options).confirm(selection);
    expect(f.fulfilledOrders()[0]?.offer).toMatchObject({ version: 'v1', fulfillmentData: {
      credits: 100, expiresInDays: 30, nested: { buckets: ['initial', null, true] },
    } });
    expect(f.resolveOffer).toHaveBeenCalledOnce();
  });

  it('freezes public referral metadata separately and preserves it on duplicate creation', async () => {
    const f = fixture(); const metadata = { affonso_referral: 'referral-original' };
    const promise = f.service.create({ ...selection, providerMetadata: metadata });
    metadata.affonso_referral = 'caller-changed';
    expect((await promise).providerMetadata).toEqual({ affonso_referral: 'referral-original' });
    expect(vi.mocked(f.adapter.create).mock.calls[0]?.[0].providerMetadata).toEqual({ affonso_referral: 'referral-original' });
    expect((await f.service.create({ ...selection, providerMetadata: { affonso_referral: 'new-referral' } })).providerMetadata)
      .toEqual({ affonso_referral: 'referral-original' });
    expect(f.adapter.create).toHaveBeenCalledOnce();
  });

  it.each([{ reference_id: 'foreign-order' }, { orderId: 'foreign-order' }, { offer_id: 'other-offer' },
    { client_reference_id: 'foreign-order' }, { request_id: 'foreign-order' }, { userId: 'foreign-owner' },
    { bad: 123 }, { bad: { nested: 'value' } }, { bad: 'x'.repeat(501) }, { 'bad\n': 'value' },
    Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`key${index}`, 'value'])),
  ])('rejects reserved or invalid public metadata before any persistence (case %#)', async (providerMetadata) => {
    const f = fixture();
    await expect(f.service.create({ ...selection, providerMetadata } as unknown as Parameters<HostedCheckoutService['create']>[0])).rejects.toThrow('metadata');
    expect(f.store.create).not.toHaveBeenCalled(); expect(f.adapter.create).not.toHaveBeenCalled();
  });

  it('rejects nonempty metadata before dispatch when the provider has no such capability', async () => {
    const f = fixture(); const service = new HostedCheckoutService({ ...f.options, providers: [{ ...f.adapter, supportsMetadata: false }] });
    await expect(service.create({ ...selection, providerMetadata: { promotekit_referral: 'referral-1' } })).rejects.toThrow('does not support');
    expect(f.store.create).not.toHaveBeenCalled(); expect(f.adapter.create).not.toHaveBeenCalled();
  });

  it.each([
    { credits: Number.NaN }, { credits: Number.POSITIVE_INFINITY }, { credits: BigInt(1) },
    { missing: undefined }, { date: new Date() }, { map: new Map() }, { run: () => true },
    { symbol: Symbol('private') }, { list: new Array(2) }, ['not-a-record'],
  ])('rejects lossy or non-JSON private fulfillment policy before writing (case %#)', async (fulfillmentData) => {
    const f = fixture();
    f.resolveOffer.mockResolvedValue({ ...offer, fulfillmentData } as unknown as HostedCheckoutOffer);
    await expect(f.service.create(selection)).rejects.toThrow('plain JSON record');
    expect(f.store.create).not.toHaveBeenCalled(); expect(f.adapter.create).not.toHaveBeenCalled();
  });

  it('rejects circular private policy and accessors without evaluating them', async () => {
    const f = fixture(); const circular: Record<string, unknown> = {}; circular.self = circular;
    f.resolveOffer.mockResolvedValueOnce({ ...offer, fulfillmentData: circular } as HostedCheckoutOffer);
    await expect(f.service.create(selection)).rejects.toThrow('plain JSON record');
    const getter = vi.fn(() => 100);
    const accessor = Object.defineProperty({}, 'credits', { enumerable: true, get: getter });
    f.resolveOffer.mockResolvedValueOnce({ ...offer, fulfillmentData: accessor });
    await expect(f.service.create(selection)).rejects.toThrow('plain JSON record');
    expect(getter).not.toHaveBeenCalled(); expect(f.store.create).not.toHaveBeenCalled();
  });

  it('never calls a provider when the storage insert or dispatch claim fails', async () => {
    const f = fixture();
    vi.mocked(f.store.create).mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(f.service.create(selection)).rejects.toThrow('Database unavailable');
    expect(f.adapter.create).not.toHaveBeenCalled();
    vi.mocked(f.store.compareAndSet).mockRejectedValueOnce(new Error('Claim failed'));
    await expect(f.service.create(selection)).rejects.toThrow('Claim failed');
    expect(f.adapter.create).not.toHaveBeenCalled();
  });

  it('claims simultaneous creation only once', async () => {
    const f = fixture();
    await Promise.all([f.service.create(selection), new HostedCheckoutService(f.options).create(selection)]);
    expect(f.adapter.create).toHaveBeenCalledOnce();
  });

  it.each([{ amount: '39', currency: 'USD' }, { amount: '29', currency: 'EUR' }])('withholds checkout URLs for known quoted-money mismatches (%j)', async dueMoney => {
    const f = fixture();
    vi.mocked(f.adapter.create).mockResolvedValueOnce(observed({ state: 'pending', dueMoney, url: 'https://checkout.example/mismatch' }));
    await expect(f.service.create(selection)).rejects.toMatchObject({ code: 'verification_failed' });
    const restarted = new HostedCheckoutService(f.options);
    expect(await restarted.create(selection)).toMatchObject({ creationState: 'submitting', checkoutUrl: null, fulfilledAt: null });
    expect(f.adapter.create).toHaveBeenCalledOnce(); expect(f.fulfilled()).toEqual([]);
  });

  it('does not confuse zero outstanding money with a valid already-paid checkout', async () => {
    const f = fixture();
    vi.mocked(f.adapter.create).mockResolvedValueOnce(observed({ dueMoney: { amount: '0', currency: 'USD' } }));
    await f.service.create(selection);
    expect(await f.service.confirm(selection)).toMatchObject({ state: 'paid' });
  });

  it('retains unknown create outcomes across restarts and recovers only a matching read-only hint', async () => {
    const f = fixture();
    vi.mocked(f.adapter.create).mockRejectedValueOnce(new Error('Lost response'));
    await expect(f.service.create(selection)).rejects.toThrow('Lost response');
    expect(await new HostedCheckoutService(f.options).create(selection)).toMatchObject({ creationState: 'submitting', checkoutId: null });
    expect(f.adapter.create).toHaveBeenCalledOnce();
    vi.mocked(f.adapter.retrieve).mockResolvedValueOnce(observed({ reference: 'foreign-order' }));
    await expect(f.service.confirm({ ...selection, checkoutId: 'checkout-1' })).rejects.toThrow('mismatch');
    expect(f.fulfilled()).toEqual([]);
    expect(await f.service.confirm({ ...selection, checkoutId: 'checkout-1' })).toMatchObject({ state: 'paid', checkoutId: 'checkout-1' });
    expect(f.fulfilled()).toEqual(['order-1']);
  });

  it('does not expose checkout success when saving the provider identity fails', async () => {
    const f = fixture();
    const compare = vi.mocked(f.store.compareAndSet).getMockImplementation()!;
    vi.mocked(f.store.compareAndSet).mockImplementation(async (id, expected, data) => {
      if (data.checkoutId) throw new Error('Identity write failed');
      return compare(id, expected, data);
    });
    await expect(f.service.create(selection)).rejects.toThrow('Identity write failed');
    expect(await f.service.create(selection)).toMatchObject({ creationState: 'submitting', checkoutId: null });
    expect(f.adapter.create).toHaveBeenCalledOnce();
  });

  it('checks owner and configured account before accessing any provider', async () => {
    const f = fixture(); await f.service.create(selection);
    await expect(f.service.confirm({ ...selection, ownerId: 'foreign-user' })).rejects.toThrow('ownership');
    await expect(f.service.capture({ ...selection, ownerId: 'foreign-user' })).rejects.toThrow('ownership');
    const other = new HostedCheckoutService({ ...f.options, providers: [{ ...f.adapter, accountScope: 'other-merchant' }] });
    await expect(other.confirm(selection)).rejects.toThrow('scope');
    expect(f.adapter.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    { checkoutId: 'foreign-checkout' }, { reference: 'foreign-order' }, { catalogReference: 'other-price' },
    { quantity: 2 }, { mode: 'subscription' as const }, { paidMoney: { amount: '28.99', currency: 'USD' } },
    { paidMoney: { amount: '29', currency: 'EUR' } },
  ])('rejects mismatched provider evidence: %j', async (changes) => {
    const f = fixture(); await f.service.create(selection);
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed(changes));
    await expect(f.service.confirm(selection)).rejects.toThrow();
    expect(f.fulfilled()).toEqual([]);
  });

  it.each([
    { state: 'pending' as const, paidMoney: undefined }, { paidMoney: undefined },
    { paymentId: undefined }, { paymentKind: undefined }, { mode: undefined },
  ])('does not grant on pending or incomplete paid evidence: %j', async (changes) => {
    const f = fixture(); await f.service.create(selection);
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed(changes));
    expect((await f.service.confirm(selection)).fulfilledAt).toBeNull();
    expect(f.fulfilled()).toEqual([]);
  });

  it('requires subscription identity for an initial subscription payment', async () => {
    const f = fixture(); f.resolveOffer.mockResolvedValue({ ...offer, mode: 'subscription' });
    vi.mocked(f.adapter.create).mockResolvedValue(observed({ mode: 'subscription' }));
    await f.service.create(selection);
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed({ mode: 'subscription' }));
    expect((await f.service.confirm(selection)).fulfilledAt).toBeNull();
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed({ mode: 'subscription', subscriptionId: 'subscription-1' }));
    expect((await f.service.confirm(selection)).state).toBe('paid');
  });

  it('does not replace a subscription identity already bound while payment was pending', async () => {
    const f = fixture(); f.resolveOffer.mockResolvedValue({ ...offer, mode: 'subscription' });
    vi.mocked(f.adapter.create).mockResolvedValue(observed({ mode: 'subscription' }));
    await f.service.create(selection);
    vi.mocked(f.adapter.retrieve).mockResolvedValueOnce(observed({ mode: 'subscription', subscriptionId: 'subscription-1', state: 'pending', paidMoney: undefined }));
    await f.service.confirm(selection);
    vi.mocked(f.adapter.retrieve).mockResolvedValueOnce(observed({ mode: 'subscription', subscriptionId: 'subscription-2' }));
    await expect(f.service.confirm(selection)).rejects.toThrow('identity changed');
    expect(f.fulfilled()).toEqual([]);
  });

  it('commits one fulfillment for concurrent return/webhook and ignores late unpaid observations', async () => {
    const f = fixture(); await f.service.create(selection);
    const request = { rawBody: 'synthetic', headers: {} };
    await Promise.all([f.service.confirm(selection), f.service.webhook('synthetic', request)]);
    expect(f.fulfilled()).toEqual(['order-1']);
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed({ state: 'unpaid', paidMoney: undefined }));
    expect((await f.service.webhook('synthetic', request))?.state).toBe('paid');
    expect(f.fulfilled()).toEqual(['order-1']);
  });

  it('rolls back the paid claim with a failed fulfillment and safely retries', async () => {
    const f = fixture(); await f.service.create(selection); f.failFulfillment(true);
    await expect(f.service.confirm(selection)).rejects.toThrow('Entitlement write failed');
    expect((await f.service.get(selection.orderId, selection.ownerId)).fulfilledAt).toBeNull();
    expect(f.fulfilled()).toEqual([]);
    f.failFulfillment(false); await f.service.confirm(selection);
    expect(f.fulfilled()).toEqual(['order-1']);
  });

  it('verifies webhook before lookup and always re-reads provider state', async () => {
    const f = fixture(); await f.service.create(selection);
    vi.mocked(f.adapter.verifyWebhook).mockRejectedValueOnce(new Error('Invalid signature'));
    await expect(f.service.webhook('synthetic', { rawBody: 'invalid', headers: {} })).rejects.toThrow('Invalid signature');
    expect(f.adapter.retrieve).not.toHaveBeenCalled();
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed({ state: 'pending', paidMoney: undefined }));
    await f.service.webhook('synthetic', { rawBody: 'verified event claims paid', headers: {} });
    expect(f.adapter.retrieve).toHaveBeenCalledOnce(); expect(f.fulfilled()).toEqual([]);
  });

  it('uses a durable capture claim and never repeats a lost capture', async () => {
    const f = fixture(); await f.service.create(selection);
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed({ state: 'requires_capture', paidMoney: undefined }));
    await f.service.confirm(selection); expect(f.adapter.capture).not.toHaveBeenCalled();
    vi.mocked(f.adapter.capture!).mockRejectedValueOnce(new Error('Capture response lost'));
    await expect(f.service.capture(selection)).rejects.toThrow('Capture response lost');
    await new HostedCheckoutService(f.options).capture(selection);
    expect(f.adapter.capture).toHaveBeenCalledOnce(); expect(f.fulfilled()).toEqual([]);
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed());
    expect((await f.service.confirm(selection)).captureState).toBe('confirmed');
    expect(f.fulfilled()).toEqual(['order-1']);
  });

  it('checks approved money before capture and claims concurrent captures once', async () => {
    const f = fixture(); await f.service.create(selection);
    vi.mocked(f.adapter.retrieve).mockResolvedValueOnce(observed({ state: 'requires_capture', dueMoney: { amount: '30', currency: 'USD' } }));
    await expect(f.service.capture(selection)).rejects.toThrow('Approved');
    expect(f.adapter.capture).not.toHaveBeenCalled();
    vi.mocked(f.adapter.retrieve).mockResolvedValue(observed({ state: 'requires_capture', paidMoney: undefined }));
    await Promise.all([f.service.capture(selection), f.service.capture(selection)]);
    expect(f.adapter.capture).toHaveBeenCalledOnce(); expect(f.fulfilled()).toEqual(['order-1']);
  });
});
