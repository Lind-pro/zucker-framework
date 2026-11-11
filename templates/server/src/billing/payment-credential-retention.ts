import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { HostedCheckoutError } from '@zucker-framework/payment';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { BillingService } from './billing.service';
import { recordedPaymentRevision, type PaymentCredentialResolver } from './payment-credentials';
import { PAYMENT_PROFILE_PROVIDERS, type PaymentProfileProviderId } from './providers';

/**
 * Operator purge of superseded payment credentials (decision D13). Archived payment revisions are
 * never removed automatically; a superadmin may remove a revision only when ALL of these hold:
 * - it is older than the retention period (`CONNECTION_REVISION_RETENTION_DAYS`, default and minimum 400);
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
export function paymentRevisionRetentionDays(env: Readonly<NodeJS.ProcessEnv>): number {
  const raw = env.CONNECTION_REVISION_RETENTION_DAYS?.trim();
  if (!raw) return PAYMENT_REVISION_RETENTION_MIN_DAYS;
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(days) || days < PAYMENT_REVISION_RETENTION_MIN_DAYS || days > 36_500)
    throw new Error(`CONNECTION_REVISION_RETENTION_DAYS must be an integer from ${PAYMENT_REVISION_RETENTION_MIN_DAYS} to 36500`);
  return days;
}

export type PaymentRevisionHold = 'current' | 'too-recent' | 'unfinished-order' | 'open-subscription' | 'open-refund' | 'refund-horizon';
export interface PaymentRevisionStatus { revision: number; createdAt: string; current: boolean; holds: PaymentRevisionHold[]; purgeable: boolean }
export interface PaymentPurgeRequest { profileId: string; dryRun: boolean; revisions?: number[] }
export interface PaymentPurgeContext { method: string; path: string; ipAddress?: string }

function providerOf(profileId: string): PaymentProfileProviderId {
  const id = (Object.keys(PAYMENT_PROFILE_PROVIDERS) as PaymentProfileProviderId[]).find(key => PAYMENT_PROFILE_PROVIDERS[key].profileId === profileId);
  if (!id) throw new NotFoundException('Unknown payment connection profile');
  return id;
}
/** Exact-key validation of the purge body. `dryRun` defaults to true: deleting needs an explicit `false`. */
export function parsePaymentPurgeRequest(body: unknown): PaymentPurgeRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid purge request');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !['profileId', 'dryRun', 'revisions'].includes(key)) || typeof input.profileId !== 'string'
    || input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new BadRequestException('Invalid purge request');
  providerOf(input.profileId);
  let revisions: number[] | undefined;
  if (input.revisions !== undefined) {
    if (!Array.isArray(input.revisions) || !input.revisions.length || input.revisions.length > 1000
      || input.revisions.some(value => !Number.isSafeInteger(value) || (value as number) < 1)) throw new BadRequestException('Invalid purge revisions');
    revisions = [...new Set(input.revisions as number[])].sort((a, b) => a - b);
  }
  return { profileId: input.profileId, dryRun: input.dryRun !== false, ...(revisions ? { revisions } : {}) };
}

@Injectable()
export class PaymentCredentialRetention {
  readonly retentionDays: number;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly billing: BillingService,
    @Optional() private readonly connections?: ConnectionSettingsService) {
    // Validated at start-up: a retention below the 400-day floor is a configuration error.
    this.retentionDays = paymentRevisionRetentionDays(connections?.runtime.base ?? process.env);
  }
  private get settings(): ConnectionSettingsService {
    if (!this.connections || !this.billing.paymentCredentials) throw new ServiceUnavailableException('Payment credentials are not managed by saved connection profiles in this process');
    return this.connections;
  }
  private resolver(): PaymentCredentialResolver {
    const resolver = this.billing.paymentCredentials;
    if (!resolver) throw new ServiceUnavailableException('Payment credentials are not managed by saved connection profiles in this process');
    return resolver;
  }
  /** Only a holder of the `superadmin` role (not a permission code that happens to share the name). */
  async assertSuperadmin(userId: string): Promise<void> {
    const rows = await this.database.transaction(tx => tx.query(`SELECT 1 FROM user_roles AS link JOIN roles AS role ON role.id = link."roleId"
      WHERE link."userId" = $1 AND role.name = 'superadmin' AND (link."expiresAt" IS NULL OR link."expiresAt" > now()) LIMIT 1`, [userId]));
    if (!rows.rows.length) throw new ForbiddenException('Only a superadmin can manage retained payment credentials');
  }

  /** Revisions held by records that may still contact the provider, with the reason (computed under the caller's lock). */
  private async holds(tx: ApplicationTransaction, providerId: PaymentProfileProviderId, now: Date): Promise<Map<number, Set<PaymentRevisionHold>>> {
    const resolver = this.resolver(), profileId = PAYMENT_PROFILE_PROVIDERS[providerId].profileId;
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
    const unfinished = await tx.query<{ accountScope: string; configRevision: string | null }>(`SELECT DISTINCT "accountScope", "configRevision" FROM billing_orders
      WHERE "providerId" = $1 AND "fulfilledAt" IS NULL AND "createdAt" > $2`, [providerId, horizon]);
    for (const row of unfinished.rows) {
      try { hold(recordedPaymentRevision(row.configRevision, profileId), 'unfinished-order'); } catch { /* not written by this server; resolves nothing */ }
      hold(await target(row.accountScope, row.configRevision, true), 'unfinished-order');
    }
    const scopes = async (sql: string, values: unknown[], reason: PaymentRevisionHold) => {
      for (const row of (await tx.query<{ accountScope: string }>(sql, values)).rows) hold(await target(row.accountScope, null, false), reason);
    };
    await scopes(`SELECT DISTINCT "accountScope" FROM billing_orders WHERE "providerId" = $1 AND "fulfilledAt" > $2`, [providerId, horizon], 'refund-horizon');
    await scopes(`SELECT DISTINCT "accountScope" FROM billing_subscription_cycles WHERE "providerId" = $1 AND "paidAt" > $2`, [providerId, horizon], 'refund-horizon');
    await scopes(`SELECT DISTINCT "accountScope" FROM billing_subscriptions WHERE "providerId" = $1
      AND (status <> 'canceled' OR "cancelState" = 'submitting')`, [providerId], 'open-subscription');
    await scopes(`SELECT DISTINCT payment."accountScope" FROM billing_refund_payments AS payment WHERE payment."providerId" = $1
      AND (payment."activeRequestId" IS NOT NULL OR payment.attention OR COALESCE(payment."providerPendingMinor", '0') <> '0'
        OR EXISTS (SELECT 1 FROM billing_refund_requests AS request WHERE request."targetId" = payment.id
          AND (request.state NOT IN ('succeeded','failed','canceled') OR request."creditState" IN ('held','attention'))))`, [providerId], 'open-refund');
    return result;
  }

  private async statuses(tx: ApplicationTransaction, providerId: PaymentProfileProviderId, now: Date): Promise<PaymentRevisionStatus[]> {
    const store = this.settings.runtime.store, profileId = PAYMENT_PROFILE_PROVIDERS[providerId].profileId;
    const [current, archived, holds] = [await store.currentRevision(tx, profileId), await store.revisions(tx, profileId), await this.holds(tx, providerId, now)];
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
    const now = new Date(), profiles = [];
    for (const providerId of Object.keys(PAYMENT_PROFILE_PROVIDERS) as PaymentProfileProviderId[]) {
      const profileId = PAYMENT_PROFILE_PROVIDERS[providerId].profileId;
      profiles.push({ profileId, revisions: await this.database.transaction(tx => this.statuses(tx, providerId, now)) });
    }
    return { retentionDays: this.retentionDays, profiles };
  }

  /**
   * Dry run (default) or purge, under the profile's lock so no save can interleave. Explicit
   * `revisions` that are not all purgeable refuse the whole request (409, nothing deleted). Without
   * `revisions`, every purgeable revision is selected. Each call writes one audit row.
   */
  async purge(actorId: string, request: PaymentPurgeRequest, context: PaymentPurgeContext) {
    await this.assertSuperadmin(actorId);
    const providerId = providerOf(request.profileId), store = this.settings.runtime.store;
    const outcome = await this.database.transaction(async tx => {
      await store.lock(tx, request.profileId);
      const now = new Date(), statuses = await this.statuses(tx, providerId, now);
      const byRevision = new Map(statuses.map(row => [row.revision, row]));
      const refused = (request.revisions ?? []).flatMap(revision => {
        const status = byRevision.get(revision);
        return !status ? [{ revision, holds: ['not-retained'] }] : status.purgeable ? [] : [{ revision, holds: status.holds }];
      });
      const selected = refused.length ? [] : request.revisions ?? statuses.filter(row => row.purgeable).map(row => row.revision).sort((a, b) => a - b);
      const deleted = !refused.length && !request.dryRun && selected.length ? await store.deleteRevisions(tx, request.profileId, selected) : [];
      const action = refused.length ? 'purge-refused' : request.dryRun ? 'purge-dry-run' : 'purge';
      await tx.model('operationLogs').create({ data: { module: 'payment-credentials', action, status: refused.length ? 'FAILED' : 'SUCCESS', userId: actorId,
        targetId: request.profileId, targetType: 'connection-profile', method: context.method, path: context.path, ipAddress: context.ipAddress ?? null,
        metadata: { dryRun: request.dryRun, retentionDays: this.retentionDays, requested: request.revisions ?? null, selected, deleted,
          refused: refused.map(row => ({ revision: row.revision, holds: row.holds })) } } });
      return { selected, deleted, refused, retained: statuses.length - deleted.length };
    });
    if (outcome.refused.length) // `reason` + `details` is the client-safe shape HttpExceptionFilter forwards as `result: { reason, details }`.
    throw new ConflictException({ code: 'PAYMENT_REVISION_HELD', reason: 'PAYMENT_REVISION_HELD', message: 'Some revisions cannot be purged',
      details: { refused: outcome.refused } });
    if (outcome.deleted.length) this.resolver().forget(providerId, outcome.deleted);
    return { profileId: request.profileId, dryRun: request.dryRun, retentionDays: this.retentionDays,
      selected: outcome.selected, deleted: outcome.deleted, retainedRevisions: outcome.retained };
  }
}
