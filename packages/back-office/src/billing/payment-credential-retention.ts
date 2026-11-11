import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConnectionProfileStore } from '@zucker-framework/config/connections';
import { HostedCheckoutError } from '@zucker-framework/payment';
import { billingTransaction, DEFAULT_BILLING_STORAGE, type BillingDatabase, type BillingStorage, type BillingTransaction } from './billing.database';
import { recordedPaymentRevision, type PaymentCredentialResolver, type PaymentProfileMap } from './payment-credentials';

/**
 * Operator purge of superseded payment credentials (decision D13). Archived payment revisions are
 * never removed automatically; a superadmin may remove a revision only when ALL of these hold:
 * - it is older than the retention period (default and minimum 400 days);
 * - it is not the current revision;
 * - no unfinished record still needs it: it is neither the recorded revision of an unfulfilled order
 *   created within the retention period, nor the credentials such a record resolves to (D12: the
 *   newest retained revision of its account) — unfulfilled orders created within the retention period,
 *   orders fulfilled or subscription payments made within it (refund horizon), subscriptions that are
 *   not canceled, and refunds whose cash or credit outcome is not final.
 * Dry runs and refusals are audited like purges. Only revision numbers, dates and counts are reported.
 */
export const PAYMENT_REVISION_RETENTION_MIN_DAYS = 400;
const DAY_MS = 86_400_000;
/** Validates a retention period in days (`undefined`/empty = the 400-day minimum). */
export function paymentRevisionRetentionDays(raw: string | number | undefined): number {
  const text = typeof raw === 'number' ? String(raw) : raw?.trim();
  if (!text) return PAYMENT_REVISION_RETENTION_MIN_DAYS;
  const days = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(days) || days < PAYMENT_REVISION_RETENTION_MIN_DAYS || days > 36_500)
    throw new Error(`Payment revision retention must be an integer from ${PAYMENT_REVISION_RETENTION_MIN_DAYS} to 36500 days`);
  return days;
}

/** The archive of saved payment connection revisions (`ConnectionProfileStore` of `@zucker-framework/config`). */
export type PaymentCredentialArchive = Pick<ConnectionProfileStore, 'lock' | 'currentRevision' | 'revisions' | 'deleteRevisions'>;
/** Who may purge retained credentials (default: holders of the `superadmin` role). */
export type PaymentCredentialOperatorCheck = (database: BillingDatabase, userId: string) => Promise<boolean>;

export type PaymentRevisionHold = 'current' | 'too-recent' | 'unfinished-order' | 'open-subscription' | 'open-refund' | 'refund-horizon';
export interface PaymentRevisionStatus { revision: number; createdAt: string; current: boolean; holds: PaymentRevisionHold[]; purgeable: boolean }
export interface PaymentPurgeRequest { profileId: string; dryRun: boolean; revisions?: number[] }
export interface PaymentPurgeContext { method: string; path: string; ipAddress?: string }

export interface PaymentCredentialRetentionOptions {
  /** Retention period in days (validated; default 400). */
  retentionDays?: number;
  storage?: BillingStorage;
  /** Default: an active `superadmin` role through the `userRoles`/`roles` tables. */
  isOperator?: PaymentCredentialOperatorCheck;
  /** `false` disables the audit row (`operationLogs` model); default on. */
  audit?: boolean;
  /** Known payment profiles when no resolver is running (requests then fail with 503 instead of 404). */
  profiles?: PaymentProfileMap;
}

/** Exact-key validation of the purge body. `dryRun` defaults to true: deleting needs an explicit `false`. */
export function parsePaymentPurgeRequest(body: unknown, profileIds: readonly string[]): PaymentPurgeRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid purge request');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !['profileId', 'dryRun', 'revisions'].includes(key)) || typeof input.profileId !== 'string'
    || input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new BadRequestException('Invalid purge request');
  if (!profileIds.includes(input.profileId)) throw new NotFoundException('Unknown payment connection profile');
  let revisions: number[] | undefined;
  if (input.revisions !== undefined) {
    if (!Array.isArray(input.revisions) || !input.revisions.length || input.revisions.length > 1000
      || input.revisions.some(value => !Number.isSafeInteger(value) || (value as number) < 1)) throw new BadRequestException('Invalid purge revisions');
    revisions = [...new Set(input.revisions as number[])].sort((a, b) => a - b);
  }
  return { profileId: input.profileId, dryRun: input.dryRun !== false, ...(revisions ? { revisions } : {}) };
}

/** Superadmin role holder through the role tables (not a permission code that happens to share the name). */
export function superadminOperator(storage: BillingStorage = DEFAULT_BILLING_STORAGE): PaymentCredentialOperatorCheck {
  return async (database, userId) => {
    const rows = await billingTransaction(database, tx => tx.query(`SELECT 1 FROM ${storage.t.userRoles} AS link JOIN ${storage.t.roles} AS role ON role.id = link."roleId"
      WHERE link."userId" = $1 AND role.name = 'superadmin' AND (link."expiresAt" IS NULL OR link."expiresAt" > now()) LIMIT 1`, [userId]));
    return rows.rows.length > 0;
  };
}

/** D13 inventory and purge of retained payment credential revisions. */
export class PaymentCredentialRetention {
  readonly retentionDays: number;
  private readonly storage: BillingStorage;
  private readonly isOperator: PaymentCredentialOperatorCheck;
  private readonly audit: boolean;
  private readonly profiles: PaymentProfileMap;
  constructor(private readonly database: BillingDatabase, private readonly billing: { readonly paymentCredentials?: PaymentCredentialResolver },
    private readonly archive?: PaymentCredentialArchive, options: PaymentCredentialRetentionOptions = {}) {
    // Validated at start-up: a retention below the 400-day floor is a configuration error.
    this.retentionDays = paymentRevisionRetentionDays(options.retentionDays);
    this.storage = options.storage ?? DEFAULT_BILLING_STORAGE;
    this.isOperator = options.isOperator ?? superadminOperator(this.storage);
    this.audit = options.audit !== false;
    this.profiles = Object.freeze({ ...(options.profiles ?? {}) });
  }
  private store(): PaymentCredentialArchive {
    if (!this.archive || !this.billing.paymentCredentials) throw new ServiceUnavailableException('Payment credentials are not managed by saved connection profiles in this process');
    return this.archive;
  }
  private resolver(): PaymentCredentialResolver {
    const resolver = this.billing.paymentCredentials;
    if (!resolver) throw new ServiceUnavailableException('Payment credentials are not managed by saved connection profiles in this process');
    return resolver;
  }
  /** Profile ids that may be inspected or purged (empty when credentials are not hot-applied). */
  profileIds(): string[] { return this.profileEntries().map(row => row.profileId); }
  private profileEntries(): ReadonlyArray<{ providerId: string; profileId: string }> {
    return this.billing.paymentCredentials?.profileIds()
      ?? Object.entries(this.profiles).map(([providerId, profile]) => ({ providerId, profileId: profile.profileId }));
  }
  private providerOf(profileId: string): string {
    const entry = this.profileEntries().find(row => row.profileId === profileId);
    if (!entry) throw new NotFoundException('Unknown payment connection profile');
    return entry.providerId;
  }
  async assertSuperadmin(userId: string): Promise<void> {
    if (!(await this.isOperator(this.database, userId))) throw new ForbiddenException('Only a superadmin can manage retained payment credentials');
  }

  /** Revisions held by records that may still contact the provider, with the reason (computed under the caller's lock). */
  private async holds(tx: BillingTransaction, providerId: string, profileId: string, now: Date): Promise<Map<number, Set<PaymentRevisionHold>>> {
    const resolver = this.resolver(), t = this.storage.t;
    const horizon = new Date(now.getTime() - this.retentionDays * DAY_MS);
    const result = new Map<number, Set<PaymentRevisionHold>>();
    const hold = (revision: number | undefined, reason: PaymentRevisionHold) => {
      if (revision === undefined) return;
      if (!result.has(revision)) result.set(revision, new Set()); result.get(revision)!.add(reason);
    };
    // An unreadable archive row (503) fails the whole call: a hold must never be missed.
    const target = async (accountScope: string, configRevision: string | null, order: boolean) => {
      try { return await resolver.resolveRevision(providerId, accountScope, configRevision, order); }
      catch (error) { if (error instanceof HostedCheckoutError) return undefined; throw error; }
    };
    const unfinished = await tx.query<{ accountScope: string; configRevision: string | null }>(`SELECT DISTINCT "accountScope", "configRevision" FROM ${t.orders}
      WHERE "providerId" = $1 AND "fulfilledAt" IS NULL AND "createdAt" > $2`, [providerId, horizon]);
    for (const row of unfinished.rows) {
      try { hold(recordedPaymentRevision(row.configRevision, profileId), 'unfinished-order'); } catch { /* not written by this server; resolves nothing */ }
      hold(await target(row.accountScope, row.configRevision, true), 'unfinished-order');
    }
    const scopes = async (sql: string, values: unknown[], reason: PaymentRevisionHold) => {
      for (const row of (await tx.query<{ accountScope: string }>(sql, values)).rows) hold(await target(row.accountScope, null, false), reason);
    };
    await scopes(`SELECT DISTINCT "accountScope" FROM ${t.orders} WHERE "providerId" = $1 AND "fulfilledAt" > $2`, [providerId, horizon], 'refund-horizon');
    await scopes(`SELECT DISTINCT "accountScope" FROM ${t.subscriptionCycles} WHERE "providerId" = $1 AND "paidAt" > $2`, [providerId, horizon], 'refund-horizon');
    await scopes(`SELECT DISTINCT "accountScope" FROM ${t.subscriptions} WHERE "providerId" = $1
      AND (status <> 'canceled' OR "cancelState" = 'submitting')`, [providerId], 'open-subscription');
    await scopes(`SELECT DISTINCT payment."accountScope" FROM ${t.refundPayments} AS payment WHERE payment."providerId" = $1
      AND (payment."activeRequestId" IS NOT NULL OR payment.attention OR COALESCE(payment."providerPendingMinor", '0') <> '0'
        OR EXISTS (SELECT 1 FROM ${t.refundRequests} AS request WHERE request."targetId" = payment.id
          AND (request.state NOT IN ('succeeded','failed','canceled') OR request."creditState" IN ('held','attention'))))`, [providerId], 'open-refund');
    return result;
  }

  private async statuses(tx: BillingTransaction, providerId: string, profileId: string, now: Date): Promise<PaymentRevisionStatus[]> {
    const store = this.store();
    const [current, archived, holds] = [await store.currentRevision(tx, profileId), await store.revisions(tx, profileId), await this.holds(tx, providerId, profileId, now)];
    const cutoff = now.getTime() - this.retentionDays * DAY_MS;
    return archived.map(row => {
      const reasons = new Set(holds.get(row.revision) ?? []);
      if (row.revision === current) reasons.add('current');
      if (row.createdAt.getTime() > cutoff) reasons.add('too-recent');
      return { revision: row.revision, createdAt: row.createdAt.toISOString(), current: row.revision === current, holds: [...reasons].sort(), purgeable: !reasons.size };
    });
  }

  /** `GET`: retained revisions of every payment profile with their holds (metadata only). */
  async inventory(actorId: string) {
    await this.assertSuperadmin(actorId);
    this.store();
    const now = new Date(), profiles = [];
    for (const { providerId, profileId } of this.profileEntries())
      profiles.push({ profileId, revisions: await billingTransaction(this.database, tx => this.statuses(tx, providerId, profileId, now)) });
    return { retentionDays: this.retentionDays, profiles };
  }

  /**
   * Dry run (default) or purge, under the profile's lock so no save can interleave. Explicit
   * `revisions` that are not all purgeable refuse the whole request (409, nothing deleted). Without
   * `revisions`, every purgeable revision is selected. Each call writes one audit row.
   */
  async purge(actorId: string, request: PaymentPurgeRequest, context: PaymentPurgeContext) {
    await this.assertSuperadmin(actorId);
    const providerId = this.providerOf(request.profileId), store = this.store();
    const outcome = await billingTransaction(this.database, async tx => {
      await store.lock(tx, request.profileId);
      const now = new Date(), statuses = await this.statuses(tx, providerId, request.profileId, now);
      const byRevision = new Map(statuses.map(row => [row.revision, row]));
      const refused = (request.revisions ?? []).flatMap(revision => {
        const status = byRevision.get(revision);
        return !status ? [{ revision, holds: ['not-retained'] }] : status.purgeable ? [] : [{ revision, holds: status.holds }];
      });
      const selected = refused.length ? [] : request.revisions ?? statuses.filter(row => row.purgeable).map(row => row.revision).sort((a, b) => a - b);
      const deleted = !refused.length && !request.dryRun && selected.length ? await store.deleteRevisions(tx, request.profileId, selected) : [];
      const action = refused.length ? 'purge-refused' : request.dryRun ? 'purge-dry-run' : 'purge';
      if (this.audit) await this.storage.model(tx, 'operationLogs').create({ data: { module: 'payment-credentials', action, status: refused.length ? 'FAILED' : 'SUCCESS', userId: actorId,
        targetId: request.profileId, targetType: 'connection-profile', method: context.method, path: context.path, ipAddress: context.ipAddress ?? null,
        metadata: { dryRun: request.dryRun, retentionDays: this.retentionDays, requested: request.revisions ?? null, selected, deleted,
          refused: refused.map(row => ({ revision: row.revision, holds: row.holds })) } } });
      return { selected, deleted, refused, retained: statuses.length - deleted.length };
    });
    if (outcome.refused.length) // `reason` + `details` is the client-safe shape the HTTP exception filter forwards as `result: { reason, details }`.
      throw new ConflictException({ code: 'PAYMENT_REVISION_HELD', reason: 'PAYMENT_REVISION_HELD', message: 'Some revisions cannot be purged',
        details: { refused: outcome.refused } });
    if (outcome.deleted.length) this.resolver().forget(providerId, outcome.deleted);
    return { profileId: request.profileId, dryRun: request.dryRun, retentionDays: this.retentionDays,
      selected: outcome.selected, deleted: outcome.deleted, retainedRevisions: outcome.retained };
  }
}
