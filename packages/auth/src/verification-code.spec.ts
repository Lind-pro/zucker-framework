import { VerificationCodeService, CacheVerificationAttemptStore, VerificationCodeError } from './verification-code';
import type { VerificationCodeStore } from './verification-code';

function fixture() {
  const tx = { marker: 'transaction' };
  const store: VerificationCodeStore<typeof tx> = {
    transactions: { run: (_subject, work) => work(tx) },
    latest: vi.fn().mockResolvedValue(null), replace: vi.fn(), claim: vi.fn().mockResolvedValue(true),
  };
  const attempts = { remainingLock: vi.fn().mockResolvedValue(0), recordFailure: vi.fn().mockResolvedValue(0), clearFailures: vi.fn() };
  return { tx, store, attempts, service: new VerificationCodeService(store, attempts, {
    expirySeconds: 900, resendSeconds: 60, now: () => new Date('2026-09-11T00:00:00Z'),
  }) };
}

describe('verification code lifecycle', () => {
  it('throttles within the locked scope without invalidating or creating another code', async () => {
    const f = fixture();
    vi.mocked(f.store.latest).mockResolvedValue({ id: 'v', code: '123456', used: false,
      createdAt: new Date('2026-09-10T23:59:30Z'), expiresAt: new Date('2026-09-11T00:14:30Z') });
    expect(await f.service.issue('subject', 'login')).toEqual({ issued: false, waitSeconds: 30 });
    expect(f.store.replace).not.toHaveBeenCalled();
  });
  it('preserves purpose and passes the same transaction to the account mutation', async () => {
    const f = fixture(); const apply = vi.fn().mockResolvedValue('updated');
    expect(await f.service.consume('subject', 'reset', '123456', apply)).toBe('updated');
    expect(f.store.claim).toHaveBeenCalledWith(f.tx, 'subject', 'reset', '123456', expect.any(Date));
    expect(apply).toHaveBeenCalledWith(f.tx);
  });
  it('does not mutate an account when a code is replayed or an attempt lock is active', async () => {
    const f = fixture(); const apply = vi.fn();
    vi.mocked(f.store.claim).mockResolvedValue(false);
    await expect(f.service.consume('s', 'p', 'c', apply)).rejects.toMatchObject({ reason: 'invalid' });
    expect(f.attempts.recordFailure).toHaveBeenCalledWith('s');
    expect(apply).not.toHaveBeenCalled();
    f.attempts.remainingLock.mockResolvedValue(1800);
    vi.mocked(f.store.claim).mockClear();
    await expect(f.service.consume('s', 'p', 'c', apply)).rejects.toMatchObject({ reason: 'locked' });
    expect(f.store.claim).not.toHaveBeenCalled();
  });
});

describe('security cache failure policy', () => {
  it('rejects unavailable and degraded-after-command caches instead of accepting fallback values', async () => {
    const cache = { isAvailable: vi.fn().mockReturnValue(false), ttl: vi.fn().mockResolvedValue(-2),
      incr: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const store = new CacheVerificationAttemptStore(cache, { attemptPrefix: 'a:', lockPrefix: 'l:', maxAttempts: 5, lockSeconds: 1800 });
    await expect(store.remainingLock('s')).rejects.toBeInstanceOf(VerificationCodeError);
    expect(cache.ttl).not.toHaveBeenCalled();
    cache.isAvailable.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(store.remainingLock('s')).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('locks on the fifth persisted failure, preserving configured counter names', async () => {
    const cache = { isAvailable: () => true, ttl: vi.fn(), incr: vi.fn().mockResolvedValue(5), set: vi.fn(), delete: vi.fn() };
    const store = new CacheVerificationAttemptStore(cache, { attemptPrefix: 'a:', lockPrefix: 'l:', maxAttempts: 5, lockSeconds: 1800 });
    expect(await store.recordFailure('subject')).toBe(1800);
    expect(cache.set).toHaveBeenCalledWith('l:subject', true, 1800);
    expect(cache.delete).toHaveBeenCalledWith('a:subject');
  });
});
