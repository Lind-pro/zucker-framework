import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { createCreditLedger } from '../billing/ledger';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { JobsService } from '../jobs/jobs.service';
import type { ReferralPolicyValues } from './referral.policy';
import { REFERRAL_NOTIFIER, type ReferralNotifier } from './referral.tokens';
import { ReferralsService } from './referrals.service';

export const REFERRAL_REWARD_WAKE_SOURCE = 'referral-rewards';
export const REFERRAL_CREDIT_SOURCE = 'referral';
/** Ledger idempotency identity of one party's reward for one order (also the lot `sourceId`). */
export const referralCreditKey = (orderId: string, role: 'referrer' | 'referee') => `referral:${orderId}:${role}`;
const SCAN_LIMIT = 50;
const DAY_MS = 86_400_000;

export type ReferralSkipReason = 'refunded' | 'prior-order' | 'cap-reached' | 'code-disabled' | 'referrer-unavailable' | 'referee-unavailable';
export type ReferralRewardOutcome =
  | { status: 'granted'; orderId: string; referrerCredits: number; refereeCredits: number }
  | { status: 'skipped'; orderId: string; reason: ReferralSkipReason }
  /** Nothing decided: already rewarded (another scanner won), no binding, or the order is not old enough yet. */
  | { status: 'none'; reason: 'already-decided' | 'not-bound' | 'not-due' };

interface BindingRow { refereeId: string; referrerId: string; code: string; boundAt: Date }
interface OrderRow { id: string; fulfilledAt: Date; state: string; paymentId: string | null; providerId: string; accountScope: string }

/**
 * Background reward of the referral programme (decision D15: off by default, 7-day delay).
 *
 * Never runs inside a payment fulfillment transaction (a throwing hook there would roll back a paid
 * order): the `referral-rewards` wake source of the Jobs host scans committed rows. Per referee, one
 * transaction locks the binding row, then both credit accounts in a fixed order, re-reads everything
 * and writes exactly one `referral_rewards` row (primary key `refereeId`, unique `orderId`) together
 * with the ledger grants. The grants carry the receipts `referral:<orderId>:referrer|referee`, so a
 * second scanner, a retried scan or a replayed payment webhook can never grant twice. A failed
 * transaction leaves no row and is simply retried by the next scan.
 *
 * Only the referee's earliest fulfilled order counts. It must be at least `rewardDelayDays` old and
 * fulfilled after the binding; with refund evidence (cash refund, pending or requested refund,
 * provider refund/charge-back event) or a later `state` other than `paid`, the reward is `skipped`
 * for good. Amounts are read from the policy at grant time and frozen into the row.
 */
@Injectable()
export class ReferralRewards implements OnModuleInit {
  private readonly logger = new Logger(ReferralRewards.name);
  private readonly coordinator = new PostgresCreditOperationCoordinator();
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    private readonly referrals: ReferralsService,
    @Optional() private readonly jobs?: JobsService,
    @Optional() @Inject(REFERRAL_NOTIFIER) private readonly notifier?: ReferralNotifier) {}

  onModuleInit(): void {
    this.jobs?.registerWakeSource({ name: REFERRAL_REWARD_WAKE_SOURCE, runOnce: async () => { await this.processDue(); } });
  }

  /**
   * One scan: decides every due binding (at most `SCAN_LIMIT` per call). Idles while the programme
   * is off or an external affiliate tool is enabled. Returns the outcomes, for tests and diagnostics.
   */
  async processDue(now = this.referrals.now()): Promise<ReferralRewardOutcome[]> {
    const available = await this.referrals.availability();
    if (!available.enabled) return [];
    const cutoff = new Date(now.getTime() - available.policy.rewardDelayDays * DAY_MS);
    const due = await this.database.transaction(tx => tx.query<{ refereeId: string }>(`SELECT binding."refereeId" FROM referral_bindings AS binding
      WHERE NOT EXISTS (SELECT 1 FROM referral_rewards AS reward WHERE reward."refereeId" = binding."refereeId")
        AND EXISTS (SELECT 1 FROM billing_orders AS orders WHERE orders."ownerId" = binding."refereeId"
          AND orders."fulfilledAt" IS NOT NULL AND orders."fulfilledAt" <= $1)
      ORDER BY binding."boundAt", binding."refereeId" LIMIT ${SCAN_LIMIT}`, [cutoff]));
    const outcomes: ReferralRewardOutcome[] = [];
    for (const row of due.rows) {
      try { outcomes.push(await this.rewardReferee(row.refereeId, available.policy, now)); }
      catch (error) {
        // Logged without identities; the next scan retries (nothing was written).
        this.logger.warn(`Referral reward attempt failed (${error instanceof Error ? error.name : 'Error'}); it will be retried`);
      }
    }
    return outcomes;
  }

  /** Decides the reward of one referee under the given (current) policy values. */
  rewardReferee(refereeId: string, policy: ReferralPolicyValues, now = this.referrals.now()): Promise<ReferralRewardOutcome> {
    return this.database.transaction(async tx => {
      // Serialisation point per referee: concurrent scanners queue here and re-read below.
      const binding = (await tx.query<BindingRow>(`SELECT "refereeId", "referrerId", code, "boundAt" FROM referral_bindings
        WHERE "refereeId" = $1 FOR UPDATE`, [refereeId])).rows[0];
      if (!binding) return { status: 'none', reason: 'not-bound' };
      if ((await tx.query('SELECT 1 FROM referral_rewards WHERE "refereeId" = $1', [refereeId])).rows.length)
        return { status: 'none', reason: 'already-decided' };
      const order = (await tx.query<OrderRow>(`SELECT id, "fulfilledAt", state, "paymentId", "providerId", "accountScope" FROM billing_orders
        WHERE "ownerId" = $1 AND "fulfilledAt" IS NOT NULL ORDER BY "fulfilledAt", id LIMIT 1`, [refereeId])).rows[0];
      const cutoff = new Date(now.getTime() - policy.rewardDelayDays * DAY_MS);
      if (!order || order.fulfilledAt > cutoff) return { status: 'none', reason: 'not-due' };
      // Fixed lock order (sorted ids) for the two credit accounts: no deadlock between two rewards whose
      // parties overlap. The referrer's lock also serialises the per-referrer cap below.
      for (const id of [binding.referrerId, binding.refereeId].sort()) await this.coordinator.lockAccount(tx, id, now);
      const reason = await this.skipReason(tx, binding, order, policy);
      if (reason) {
        await this.insertReward(tx, binding, order.id, 'skipped', 0, 0, reason, now);
        return { status: 'skipped', orderId: order.id, reason };
      }
      const referrerCredits = policy.referrerCredits, refereeCredits = policy.refereeCredits;
      if (!await this.insertReward(tx, binding, order.id, 'granted', referrerCredits, refereeCredits, null, now))
        return { status: 'none', reason: 'already-decided' };
      const expiresAt = policy.rewardValidDays ? new Date(now.getTime() + policy.rewardValidDays * DAY_MS) : undefined;
      for (const [role, accountId, amount] of [['referrer', binding.referrerId, referrerCredits], ['referee', binding.refereeId, refereeCredits]] as const) {
        if (amount < 1) continue;
        const key = referralCreditKey(order.id, role), description = role === 'referrer' ? 'Referral reward' : 'Referral welcome reward';
        await createCreditLedger(this.database).grant(tx, {
          accountId, amount, source: REFERRAL_CREDIT_SOURCE, sourceId: key, expiresAt, description,
          operation: { idempotencyKey: key, accountId, operationType: 'REFERRAL_CREDIT_GRANT', amount, resourceType: 'referral', resourceId: binding.refereeId },
          transactionData: { type: 'GRANT', description, expireAt: expiresAt ?? null,
            metadata: { source: REFERRAL_CREDIT_SOURCE, sourceId: key, role, validDays: policy.rewardValidDays } },
        });
        await this.notify(tx, { userId: accountId, credits: amount, role, eventKey: key, rewardId: key, orderId: order.id });
      }
      return { status: 'granted', orderId: order.id, referrerCredits, refereeCredits };
    });
  }

  private async skipReason(tx: ApplicationTransaction, binding: BindingRow, order: OrderRow, policy: ReferralPolicyValues): Promise<ReferralSkipReason | null> {
    // An existing customer (paid before the binding, e.g. a claim racing its first fulfilment) never qualifies.
    if (order.fulfilledAt < binding.boundAt) return 'prior-order';
    if (order.state !== 'paid' || await this.hasRefundEvidence(tx, order)) return 'refunded';
    const parties = (await tx.query<{ id: string; status: boolean }>('SELECT id, status FROM users WHERE id IN ($1, $2)',
      [binding.referrerId, binding.refereeId])).rows;
    if (!parties.find(row => row.id === binding.refereeId)?.status) return 'referee-unavailable';
    if (!parties.find(row => row.id === binding.referrerId)?.status) return 'referrer-unavailable';
    const code = (await tx.query<{ disabledAt: Date | null }>('SELECT "disabledAt" FROM referral_codes WHERE "userId" = $1', [binding.referrerId])).rows[0];
    if (!code || code.disabledAt) return 'code-disabled';
    if (policy.maxRewardsPerReferrer > 0) {
      const granted = (await tx.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM referral_rewards WHERE "referrerId" = $1 AND status = 'granted'`,
        [binding.referrerId])).rows[0].count;
      if (granted >= policy.maxRewardsPerReferrer) return 'cap-reached';
    }
    return null;
  }

  /**
   * Any trace of money going back for this order: a refund target with refunded, pending or
   * recovered amounts, a request, a receipt or a provider refund event (matched to the target, or
   * still unmatched but naming the order's payment). Conservative on purpose: it only ever skips.
   */
  private async hasRefundEvidence(tx: ApplicationTransaction, order: OrderRow): Promise<boolean> {
    const result = await tx.query<{ found: boolean }>(`SELECT (
        EXISTS (SELECT 1 FROM billing_refund_payments AS payment WHERE payment."orderId" = $1 AND (
          payment."refundedMinor" <> '0' OR payment."providerPendingMinor" IS NOT NULL OR payment."activeRequestId" IS NOT NULL
          OR payment."recoveredCredits" > 0 OR payment."suppressedCredits" > 0 OR payment.attention
          OR EXISTS (SELECT 1 FROM billing_refund_requests AS request WHERE request."targetId" = payment.id)
          OR EXISTS (SELECT 1 FROM billing_refund_receipts AS receipt WHERE receipt."targetId" = payment.id)
          OR EXISTS (SELECT 1 FROM billing_refund_events AS event WHERE event."targetId" = payment.id
            OR (event."providerId" = payment."providerId" AND event."accountScope" = payment."accountScope"
              AND event."sourceKind" = payment."sourceKind" AND event."sourceId" = payment."sourceId"))))
        OR ($2::text IS NOT NULL AND EXISTS (SELECT 1 FROM billing_refund_events AS event
          WHERE event."providerId" = $3 AND event."accountScope" = $4 AND event."sourceId" = $2))
      ) AS found`, [order.id, order.paymentId, order.providerId, order.accountScope]);
    return result.rows[0]?.found === true;
  }

  private async insertReward(tx: ApplicationTransaction, binding: BindingRow, orderId: string, status: 'granted' | 'skipped',
    referrerCredits: number, refereeCredits: number, skipReason: string | null, now: Date): Promise<boolean> {
    // Primary key (referee) and unique order: a collision means another writer already decided.
    const inserted = await tx.query(`INSERT INTO referral_rewards ("refereeId", "referrerId", "orderId", "referrerCredits", "refereeCredits", status, "skipReason", "createdAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING "refereeId"`,
    [binding.refereeId, binding.referrerId, orderId, referrerCredits, refereeCredits, status, skipReason, now]);
    return inserted.rows.length === 1;
  }

  private async notify(tx: ApplicationTransaction, notice: Parameters<ReferralNotifier['notifyReward']>[1]): Promise<void> {
    if (!this.notifier) return;
    await tx.query('SAVEPOINT referral_notice');
    try {
      await this.notifier.notifyReward(tx, notice);
      await tx.query('RELEASE SAVEPOINT referral_notice');
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT referral_notice');
      this.logger.warn(`Referral reward notification failed (${error instanceof Error ? error.name : 'Error'}); the reward is kept`);
    }
  }
}
