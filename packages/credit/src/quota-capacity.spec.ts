import {
  QuotaCapacity,
  QuotaCapacityExceededError,
  QuotaCapacityInputError,
  type QuotaCapacityStore,
  type QuotaReservationCapacity,
} from './quota-capacity';

function harness(reservations: QuotaReservationCapacity[] = [], initialUsed = 0) {
  let used = initialUsed;
  let limit = 3;
  const store: QuotaCapacityStore = {
    lock: vi.fn(async () => {}),
    ensureUsage: vi.fn(async (_key, configured) => {
      limit = configured;
      return { used, limit };
    }),
    readUsage: vi.fn(async () => ({ used, limit })),
    reservations: vi.fn(async () => reservations),
    incrementIfCapacity: vi.fn(async (_key, amount, max) => {
      if (used > max) return false;
      used += amount;
      return true;
    }),
  };
  return { store, used: () => used };
}
const request = {
  subjectId: 'subject',
  counter: 'reports',
  period: '2026-09',
  amount: 1,
  limit: 3,
  now: new Date('2026-09-11'),
};

describe('quota capacity', () => {
  it('counts current and unknown legacy reservations, excluding expired and known other periods', async () => {
    const { store } = harness([
      { amount: 1, period: '2026-09', expiresAt: new Date('2026-09-12') },
      { amount: 1, expiresAt: new Date('2026-09-12') },
      { amount: 10, period: '2026-08', expiresAt: new Date('2026-09-12') },
      { amount: 10, period: '2026-09', expiresAt: new Date('2026-09-10') },
    ]);
    const engine = new QuotaCapacity();
    expect(await engine.check(store, request)).toMatchObject({
      used: 0,
      reserved: 2,
      remaining: 1,
      allowed: true,
    });
    expect(await engine.consume(store, request)).toMatchObject({
      used: 1,
      reserved: 2,
      remaining: 0,
    });
    expect(await engine.check(store, request)).toMatchObject({ allowed: false });
  });
  it('uses the atomic database predicate under concurrent consumption', async () => {
    const { store, used } = harness();
    const engine = new QuotaCapacity();
    const results = await Promise.allSettled([
      engine.consume(store, { ...request, limit: 1 }),
      engine.consume(store, { ...request, limit: 1 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(used()).toBe(1);
    expect(
      results.some(
        (result) =>
          result.status === 'rejected' && result.reason instanceof QuotaCapacityExceededError,
      ),
    ).toBe(true);
  });
  it('never treats a negative configured limit as unlimited or accepts a negative increment', async () => {
    const { store } = harness();
    const engine = new QuotaCapacity();
    expect((await engine.check(store, { ...request, limit: -1 })).allowed).toBe(false);
    await expect(engine.consume(store, { ...request, amount: -1 })).rejects.toBeInstanceOf(
      QuotaCapacityInputError,
    );
    expect(store.incrementIfCapacity).not.toHaveBeenCalled();
  });
  it('preserves existing usage when a plan limit changes and propagates storage errors', async () => {
    const { store } = harness([], 2);
    const engine = new QuotaCapacity();
    expect(await engine.check(store, { ...request, limit: 1 })).toMatchObject({
      used: 2,
      limit: 1,
      allowed: false,
    });
    vi.mocked(store.ensureUsage).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(engine.consume(store, request)).rejects.toThrow('database unavailable');
    expect(store.incrementIfCapacity).not.toHaveBeenCalled();
  });
});
