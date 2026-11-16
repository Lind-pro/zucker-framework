import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  HostedCheckoutError, HOSTED_CHECKOUT_MAX_WEBHOOK_CANDIDATES,
  type HostedCheckoutAdapter, type HostedCheckoutCurrentProvider, type HostedCheckoutOrder, type HostedCheckoutProviderResolver,
  type RefundAdapter, type SubscriptionAdapter,
} from '@zucker-framework/payment';

/** Adapters of one payment provider built from one configuration (checkout, renewal and refund). */
export interface PaymentProviderSet { checkout: HostedCheckoutAdapter; subscription?: SubscriptionAdapter; refund?: RefundAdapter }

/** How one provider's credentials are stored as a connection profile and read from its environment. */
export interface PaymentProfileDescriptor {
  /** Connection profile id, `payment-<provider>` (for example `payment-stripe`). */
  readonly profileId: string;
  /** Environment key of the provider mode (test/live/…); revisions of an order must keep it. */
  readonly modeKey: string;
  /** Environment key of the provider account scope. */
  readonly scopeKey: string;
  /** Environment keys of webhook signing secrets (distinct secrets are distinct verification candidates). */
  readonly webhookKeys: readonly string[];
}
export type PaymentProfileMap = Readonly<Record<string, PaymentProfileDescriptor>>;

/**
 * Hot-applied payment credentials (WP 4.1c, decision D12).
 *
 * - New orders use the CURRENT stored revision of the provider's `payment-<id>` profile (one indexed
 *   read per order, no cache, so no replica ever opens a new order on a superseded revision) and record
 *   it as `payment-<id>@<revision>` on the order before the dispatch claim.
 * - Existing orders, subscriptions and refunds use the NEWEST retained revision of the SAME provider
 *   account (account scope; for orders also the mode of the recorded revision) at or after the
 *   order's recorded revision. Key rotation inside one account therefore moves old orders to the new
 *   key; a switch to another account leaves old orders on the last revision of their own account.
 * - Webhooks are verified against the current and retained revisions, newest first, one candidate per
 *   distinct account and signing secret, at most eight.
 *
 * Revision 0 is the process environment alone (a profile that was never saved, or whose live value
 * was deleted). Archived revisions are immutable and never renumbered, so adapters are cached per
 * (provider, revision). Secrets live only inside adapters and the encrypted archive; nothing here logs
 * or returns them (warnings carry provider ids, revision numbers and error class names only).
 */

/** The narrow part of `ConnectionSettingsService` the resolver reads (internal; never HTTP). */
export interface PaymentCredentialSettings {
  currentRevision(profileId: string): Promise<number>;
  revisions(profileId: string): Promise<ReadonlyArray<{ revision: number; createdAt: Date }>>;
  environmentAt(profileId: string, revision: number): Promise<Readonly<NodeJS.ProcessEnv> | undefined>;
  readonly runtime: { readonly base: Readonly<NodeJS.ProcessEnv> };
}

export interface PaymentCredentialEntry extends PaymentProviderSet {
  readonly providerId: string;
  readonly revision: number;
  readonly accountScope: string;
  readonly mode: string;
  /** Distinct webhook verification identity: account scope plus a digest of the signing secret (PayPal: scope only). */
  readonly webhookKey: string;
}

/** Per-account adapters for subscription and refund services (rows carry provider id and account scope). */
export interface AccountAdapterSource<T extends { readonly id: string; readonly accountScope: string }> {
  /** True when this provider id is served at all (its records must then resolve, or the operation stops). */
  knows(providerId: string): boolean;
  /**
   * The adapter for records of `accountScope`. A static source returns its only adapter of that id
   * whatever its scope (the caller refuses a scope mismatch); a credential source returns only a
   * matching account's adapter, or undefined.
   */
  forAccount(providerId: string, accountScope: string): Promise<T | undefined>;
  /** Webhook verification candidates, newest first (at most eight). */
  webhookCandidates(providerId: string): Promise<readonly T[]>;
}

/** Fixed adapters (credentials fixed for the process lifetime). */
export function staticAccountAdapters<T extends { readonly id: string; readonly accountScope: string }>(adapters: readonly T[]): AccountAdapterSource<T> {
  const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
  return {
    knows: providerId => byId.has(providerId),
    forAccount: async providerId => byId.get(providerId),
    webhookCandidates: async providerId => { const adapter = byId.get(providerId); return adapter ? [adapter] : []; },
  };
}

/**
 * Tries webhook verification with each candidate, newest first, and returns the first verified result
 * with its candidate. When none verifies, the newest candidate's error is rethrown.
 */
export async function verifyWithCandidates<T, R>(candidates: readonly T[], verify: (candidate: T) => Promise<R>): Promise<{ candidate: T; result: R } | undefined> {
  let failure: unknown, failed = false;
  for (const candidate of candidates.slice(0, HOSTED_CHECKOUT_MAX_WEBHOOK_CANDIDATES)) {
    try { return { candidate, result: await verify(candidate) }; }
    catch (error) { if (!failed) { failure = error; failed = true; } }
  }
  if (failed) throw failure;
  return undefined;
}

const RECORDED = /^(payment-[a-z]+)@(0|[1-9]\d{0,14})$/;
function forged(): never {
  throw new HostedCheckoutError('verification_failed', 'The payment configuration recorded on this order cannot be resolved');
}
/**
 * The revision of `profileId` recorded on an order: `payment-<id>@<n>`, alone or in the older
 * comma-separated list of every payment profile. `null`/absent (orders created before revisions were
 * recorded) means 0. Anything malformed, duplicated or missing this profile is refused.
 */
export function recordedPaymentRevision(value: string | null | undefined, profileId: string): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'string' || !value || value.length > 255) forged();
  const seen = new Map<string, number>();
  for (const part of value.split(',')) {
    const match = RECORDED.exec(part);
    if (!match || seen.has(match[1])) forged();
    seen.set(match[1], Number(match[2]));
  }
  const revision = seen.get(profileId);
  return revision === undefined ? forged() : revision;
}
export function paymentRevisionLabel(profileId: string, revision: number): string { return `${profileId}@${revision}`; }

export interface PaymentCredentialResolverOptions {
  /** Providers whose credentials are saved connection profiles (consumer configuration). */
  readonly profiles: PaymentProfileMap;
  /** Builds one provider's adapters from an environment, or undefined when it is disabled there. Local only (no network). */
  readonly factory: (env: NodeJS.ProcessEnv, providerId: string) => PaymentProviderSet | undefined;
  /** Providers that are not connection profiles (the TEST-ONLY fake), fixed for the process lifetime. */
  readonly fixed?: readonly PaymentProviderSet[];
  /** Adapter sets cached per (provider, revision) (default 64). */
  readonly cacheSize?: number;
  /** Most retained revisions inspected for webhook candidates (default 64). */
  readonly scanLimit?: number;
}

/** Newest-first resolution of payment credentials over the connection-profile revision archive. */
export class PaymentCredentialResolver implements HostedCheckoutProviderResolver {
  private readonly logger = new Logger('PaymentCredentials');
  private readonly factory: PaymentCredentialResolverOptions['factory'];
  private readonly profiles: PaymentProfileMap;
  private readonly fixed = new Map<string, PaymentProviderSet>();
  private readonly cache = new Map<string, Promise<PaymentCredentialEntry | null>>();
  private readonly reported = new Set<string>();
  private readonly cacheSize: number;
  private readonly scanLimit: number;
  /** Subscription adapters per account (billing subscription service). */
  readonly subscriptions: AccountAdapterSource<SubscriptionAdapter>;
  /** Refund adapters per account (billing refund service). */
  readonly refunds: AccountAdapterSource<RefundAdapter>;

  constructor(private readonly settings: PaymentCredentialSettings, options: PaymentCredentialResolverOptions) {
    if (!options || typeof options.factory !== 'function' || !options.profiles || typeof options.profiles !== 'object')
      throw new Error('Payment credential resolver needs profiles and a provider factory');
    for (const [id, profile] of Object.entries(options.profiles))
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || !/^payment-[a-z]+$/.test(profile.profileId) || !profile.modeKey || !profile.scopeKey || !Array.isArray(profile.webhookKeys))
        throw new Error('Invalid payment profile descriptor');
    this.factory = options.factory;
    this.profiles = Object.freeze({ ...options.profiles });
    this.cacheSize = options.cacheSize ?? 64; this.scanLimit = options.scanLimit ?? 64;
    if (!Number.isSafeInteger(this.cacheSize) || this.cacheSize < 4 || !Number.isSafeInteger(this.scanLimit) || this.scanLimit < 1) throw new Error('Invalid payment credential cache limits');
    for (const set of options.fixed ?? []) {
      if (!set.checkout.id || !set.checkout.accountScope || this.isProfile(set.checkout.id) || this.fixed.has(set.checkout.id))
        throw new Error('Fixed payment providers need unique ids that are not connection profiles');
      this.fixed.set(set.checkout.id, set);
    }
    this.subscriptions = this.source(set => set.subscription);
    this.refunds = this.source(set => set.refund);
  }

  /** True when `providerId` is a saved connection profile provider. */
  isProfile(providerId: string): boolean { return Object.prototype.hasOwnProperty.call(this.profiles, providerId); }
  /** The profile descriptors this resolver serves. */
  profileIds(): ReadonlyArray<{ providerId: string; profileId: string }> {
    return Object.entries(this.profiles).map(([providerId, profile]) => ({ providerId, profileId: profile.profileId }));
  }

  // ── HostedCheckoutProviderResolver ────────────────────────────────────
  async ids(): Promise<readonly string[]> {
    return (await this.currentSets()).map(set => set.checkout.id);
  }
  async current(providerId: string): Promise<HostedCheckoutCurrentProvider | undefined> {
    const fixed = this.fixed.get(providerId);
    if (fixed) return { adapter: fixed.checkout };
    if (!this.isProfile(providerId)) return undefined;
    const { profileId } = this.profiles[providerId];
    const revision = await this.settings.currentRevision(profileId);
    const entry = await this.entry(providerId, revision);
    return entry ? { adapter: entry.checkout, configRevision: paymentRevisionLabel(profileId, revision) } : undefined;
  }
  async forOrder(order: Readonly<HostedCheckoutOrder>): Promise<HostedCheckoutAdapter | undefined> {
    const fixed = this.fixed.get(order.providerId);
    if (fixed) return fixed.checkout;
    if (!this.isProfile(order.providerId)) return undefined;
    const minimum = recordedPaymentRevision(order.configRevision, this.profiles[order.providerId].profileId);
    const entry = await this.resolveAccount(order.providerId, order.accountScope, minimum, true);
    if (!entry) throw new HostedCheckoutError('verification_failed', 'No retained payment credentials of this order\'s account');
    return entry.checkout;
  }
  async webhookCandidates(providerId: string): Promise<readonly HostedCheckoutAdapter[]> {
    return (await this.candidateSets(providerId)).map(set => set.checkout);
  }

  // ── billing services ──────────────────────────────────────────────────
  /** The provider sets that accept new orders now (fixed providers plus every enabled profile's current revision). */
  async currentSets(): Promise<PaymentProviderSet[]> {
    const sets: PaymentProviderSet[] = [];
    for (const id of Object.keys(this.profiles)) {
      const entry = await this.entry(id, await this.settings.currentRevision(this.profiles[id].profileId)).catch(() => null);
      if (entry) sets.push(entry);
    }
    return [...sets, ...this.fixed.values()];
  }
  /** Newest retained set of this provider and account, for records without a recorded revision (subscriptions, refunds). */
  async forAccount(providerId: string, accountScope: string): Promise<PaymentProviderSet | undefined> {
    const fixed = this.fixed.get(providerId);
    if (fixed) return fixed.checkout.accountScope === accountScope ? fixed : undefined;
    if (!this.isProfile(providerId)) return undefined;
    return (await this.resolveAccount(providerId, accountScope, 0, false)) ?? undefined;
  }
  /**
   * Revision a record resolves to now (purge holds): for an order (`order`), D12 from its recorded
   * `configRevision`; otherwise the newest retained revision of the account. Undefined for fixed providers.
   */
  async resolveRevision(providerId: string, accountScope: string, configRevision: string | null, order: boolean): Promise<number | undefined> {
    if (!this.isProfile(providerId)) return undefined;
    const minimum = order ? recordedPaymentRevision(configRevision, this.profiles[providerId].profileId) : 0;
    return (await this.resolveAccount(providerId, accountScope, minimum, order))?.revision;
  }
  /** Drops cached adapters of purged revisions (this process; other processes evict them by LRU). */
  forget(providerId: string, revisions: readonly number[]): void {
    for (const revision of revisions) this.cache.delete(`${providerId}@${revision}`);
  }
  /** Newest-first distinct verification candidates of one provider (current and retained revisions). */
  async candidateSets(providerId: string): Promise<PaymentProviderSet[]> {
    const fixed = this.fixed.get(providerId);
    if (fixed) return [fixed];
    if (!this.isProfile(providerId)) return [];
    const { sequence } = await this.sequence(providerId);
    const result: PaymentCredentialEntry[] = [], keys = new Set<string>();
    for (const revision of sequence.slice(0, this.scanLimit)) {
      const entry = await this.entry(providerId, revision).catch(() => null);
      if (!entry || keys.has(entry.webhookKey)) continue;
      keys.add(entry.webhookKey); result.push(entry);
      if (result.length >= HOSTED_CHECKOUT_MAX_WEBHOOK_CANDIDATES) break;
    }
    return result;
  }

  /**
   * Retained revisions in recency order: the current one first. Revision 0 (environment only) is
   * newest when the profile has no live value, otherwise oldest.
   */
  async sequence(providerId: string): Promise<{ current: number; newest: number; sequence: number[] }> {
    const { profileId } = this.profiles[providerId];
    const [current, archived] = await Promise.all([this.settings.currentRevision(profileId), this.settings.revisions(profileId)]);
    const numbers = archived.map(row => row.revision).filter(revision => Number.isSafeInteger(revision) && revision > 0).sort((a, b) => b - a);
    return { current, newest: Math.max(current, numbers[0] ?? 0), sequence: current === 0 ? [0, ...numbers] : [...numbers, 0] };
  }

  /**
   * D12: the newest revision, in recency order, at or after `minimum` whose account scope equals
   * `accountScope` (and, for an order, whose mode equals that of the order's recorded revision when it is
   * retained). An order whose recorded revision is above every known revision, or names a retained
   * revision of another account, is refused (`verification_failed`): such a value was not written by this
   * server. Revision 0 is eligible only for `minimum` 0 or while the profile has no live value.
   */
  private async resolveAccount(providerId: string, accountScope: string, minimum: number, order: boolean): Promise<PaymentCredentialEntry | null> {
    const { current, newest, sequence } = await this.sequence(providerId);
    if (minimum > newest) forged();
    let mode: string | undefined;
    if (order) {
      // Revision 0 names this process's bootstrap environment, not an unspecified revision.
      // It must constrain old orders too; disabled/unassemblable bootstrap credentials cannot
      // prove the original mode. Across restarts the consumer must preserve that environment or
      // use a new account scope / a persisted revision when changing account or test/live mode.
      const recorded = sequence.includes(minimum) ? await this.entry(providerId, minimum) : null;
      if (minimum === 0 && (!recorded || !recorded.mode)) forged();
      if (recorded && recorded.accountScope !== accountScope) forged();
      mode = recorded?.mode;
    }
    for (const revision of sequence) {
      if (revision < minimum && !(revision === 0 && current === 0)) continue;
      const entry = await this.entry(providerId, revision);
      if (entry && entry.accountScope === accountScope && (mode === undefined || entry.mode === mode)) return entry;
    }
    return null;
  }

  /**
   * Adapters of one provider at one revision; null when the provider is disabled (or unassemblable) in it
   * or the revision is not retained. Only assembled or disabled results are cached; "not retained" is
   * not, so a revision number that does not exist yet is never remembered as missing. Unreadable archive
   * rows reject (503) and are not cached.
   */
  private entry(providerId: string, revision: number): Promise<PaymentCredentialEntry | null> {
    const key = `${providerId}@${revision}`, cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const { profileId, modeKey, scopeKey, webhookKeys } = this.profiles[providerId];
    let retained = true;
    const promise = (async (): Promise<PaymentCredentialEntry | null> => {
      const env = revision === 0 ? this.settings.runtime.base : await this.settings.environmentAt(profileId, revision);
      if (!env) { retained = false; return null; }
      let set: PaymentProviderSet | undefined;
      try { set = this.factory({ ...env }, providerId); }
      catch (error) {
        if (!this.reported.has(key)) {
          this.reported.add(key);
          // Class name only: provider builders may echo configuration in messages.
          this.logger.warn(`Payment configuration ${profileId}@${revision} cannot be assembled (${error instanceof Error ? error.name : 'Error'}); it is skipped`);
        }
        return null;
      }
      if (!set || set.checkout.id !== providerId || set.checkout.accountScope !== env[scopeKey]?.trim()) return null;
      const digest = createHash('sha256');
      digest.update(set.checkout.accountScope);
      for (const field of webhookKeys) digest.update('\u0000').update(env[field] ?? '');
      return { ...set, providerId, revision, accountScope: set.checkout.accountScope, mode: env[modeKey]?.trim() ?? '', webhookKey: digest.digest('hex') };
    })();
    this.cache.set(key, promise);
    void promise.then(() => { if (!retained && this.cache.get(key) === promise) this.cache.delete(key); },
      () => { if (this.cache.get(key) === promise) this.cache.delete(key); });
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    return promise;
  }

  private source<T extends { readonly id: string; readonly accountScope: string }>(pick: (set: PaymentProviderSet) => T | undefined): AccountAdapterSource<T> {
    return {
      knows: providerId => this.fixed.has(providerId) ? !!pick(this.fixed.get(providerId)!) : this.isProfile(providerId),
      forAccount: async (providerId, accountScope) => { const set = await this.forAccount(providerId, accountScope); return set ? pick(set) : undefined; },
      webhookCandidates: async providerId => (await this.candidateSets(providerId)).flatMap(set => { const adapter = pick(set); return adapter ? [adapter] : []; }),
    };
  }
}
