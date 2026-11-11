import { describe, expect, it } from 'vitest';
import { BackOfficeBillingModule, BillingStorage, DEFAULT_BILLING_PATHS, advisoryAccountLock, billingPersistenceConfig, resolveBillingOptions } from './index';

// Plans-only (no credits) needs an explicit account lock; the default credit lock needs credit tables.
const base = { runtime: { useFactory: () => ({ providers: [], webUrl: 'https://app.example.invalid' }) }, trustedOrigins: () => ['https://app.example.invalid'], lockAccount: advisoryAccountLock() };

describe('billing options', () => {
  it('defaults to plans-only with orders, subscriptions, refunds and recovery on, and the rest off', () => {
    const options = resolveBillingOptions(base);
    expect(options.persistence.credits).toBeNull();
    expect(options.features).toEqual({ orders: true, subscriptions: true, refunds: true, recovery: true, paymentCredentials: false, creditPacks: false, testCheckout: false });
    expect(options.paths).toEqual(DEFAULT_BILLING_PATHS);
    expect(options.permissions).toMatchObject({ refund: 'billing:refund', recover: 'billing:refund' });
    expect(Object.isFrozen(options) && Object.isFrozen(options.features)).toBe(true);
  });
  it('maps custom model and table names and keeps unmapped defaults', () => {
    const lock = advisoryAccountLock('x1');
    const { storage } = resolveBillingOptions({ ...base, models: { billingOrders: 'subscriptionCheckout' }, tables: { orders: 'subscription_checkout' }, lockAccount: lock }).persistence;
    expect(storage.models.billingOrders).toBe('subscriptionCheckout');
    expect(storage.models.billingOutbox).toBe('billingOutbox');
    expect(storage.t.orders).toBe('"subscription_checkout"');
    expect(storage.t.refundEvents).toBe('"billing_refund_events"');
    expect(storage.lockAccount).toBe(lock);
  });
  it.each([
    [{ ...base, trustedOrigins: undefined }, /trustedOrigins/],
    [{ trustedOrigins: base.trustedOrigins }, /either service or runtime/],
    [{ ...base, runtime: { useFactory: 1 } }, /useFactory/],
    [{ ...base, features: { bogus: true } }, /unknown feature/],
    [{ ...base, features: { refunds: 'yes' } }, /must be a boolean/],
    [{ ...base, paths: { nope: 'x' } }, /unknown path/],
    [{ ...base, paths: { billing: '../etc' } }, /path "billing" is invalid/],
    [{ ...base, paths: { billing: '/abs' } }, /invalid/],
    [{ ...base, permissions: { refund: 'refund' } }, /permission "refund" is invalid/],
    [{ ...base, permissions: { nope: 'a:b' } }, /unknown permission/],
    [{ ...base, features: { creditPacks: true } }, /creditPacks needs a credit ledger/],
    [{ ...base, features: { testCheckout: true } }, /testCheckout needs testCheckout.ledger/],
    [{ ...base, features: { paymentCredentials: true } }, /ports.credentialArchive/],
    [{ ...base, lockAccount: 'lock' }, /lockAccount must be a function/],
    [{ ...base, credits: { ledger: 'x' } }, /credits.ledger must be a function/],
    [{ ...base, lockAccount: undefined }, /plans-only billing \(credits: null\) needs lockAccount/],
  ] as const)('refuses invalid options %#', (input, message) => {
    expect(() => resolveBillingOptions(input as never)).toThrow(message);
  });
  it('validates advisory lock namespaces and owners', async () => {
    expect(() => advisoryAccountLock('Bad Name')).toThrow(/namespace/);
    const queries: unknown[][] = [];
    const lock = advisoryAccountLock('ok:1');
    await lock({ query: async (...args: unknown[]) => { queries.push(args); return { rows: [] }; } } as never, 'user-1');
    expect(queries[0][1]).toEqual(['ok:1', 'user-1']);
    await expect(lock({ query: async () => ({ rows: [] }) } as never, '')).rejects.toThrow(/needs an owner/);
  });
  it('rejects non-ledger persistence and defaults storage when absent', () => {
    expect(() => billingPersistenceConfig({ credits: {} as never })).toThrow();
    expect(billingPersistenceConfig().credits).toBeNull();
    expect(new BillingStorage().tables.orders).toBe('billing_orders');
  });
  it('registers one controller per enabled feature and none for disabled ones', () => {
    const count = (features?: Record<string, boolean>) => BackOfficeBillingModule.forRoot({ ...base, features }).controllers!.length;
    expect(count()).toBe(4);
    expect(count({ recovery: false })).toBe(3);
    expect(count({ orders: false, subscriptions: false, refunds: false, recovery: false })).toBe(0);
    expect(count({ recovery: false, orders: false, subscriptions: false })).toBe(1);
  });
  it('exports the service, options and refund summary tokens', () => {
    const module = BackOfficeBillingModule.forRoot(base);
    expect(module.exports).toHaveLength(3);
  });
});
