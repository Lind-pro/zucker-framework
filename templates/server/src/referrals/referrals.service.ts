import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { readReferralPolicy, type ReferralPolicyValues } from './referral.policy';
import { REFERRAL_OPTIONS, type ReferralOptions } from './referral.tokens';

/** Unambiguous upper-case alphabet: no I, O, 0 or 1. */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LENGTH = 8;
const CODE_SHAPE = /^[A-Z0-9]{6,16}$/;
const DAY_MS = 86_400_000;

export function generateReferralCode(random: (max: number) => number = randomInt): string {
  let code = '';
  for (let index = 0; index < REFERRAL_CODE_LENGTH; index++) code += REFERRAL_CODE_ALPHABET[random(REFERRAL_CODE_ALPHABET.length)];
  return code;
}
/** Trimmed, upper-cased code of 6–16 characters [A-Z0-9], else null (never echoes other input). */
export function normalizeReferralCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const code = value.trim().toUpperCase();
  return CODE_SHAPE.test(code) ? code : null;
}

/** The one refusal of a claim: never says which rule failed (no code enumeration, no account facts). */
export function referralNotApplicable(): BadRequestException {
  return new BadRequestException({ code: 'REFERRAL_NOT_APPLICABLE', message: 'This referral code cannot be applied' });
}

export type ReferralUnavailableReason = 'disabled' | 'external-affiliate' | 'unavailable';
export type ReferralAvailability = { enabled: true; policy: ReferralPolicyValues } | { enabled: false; reason: ReferralUnavailableReason };

export interface ReferralMeView {
  enabled: true;
  code: string;
  /** False when an operator disabled this user's code; `link` is then null. */
  codeActive: boolean;
  link: string | null;
  stats: { invited: number; rewarded: number; creditsEarned: number };
  /** Most recent invitations, without any identity of the referred users. */
  recent: Array<{ boundAt: string; status: 'pending' | 'granted' | 'skipped' }>;
}

export interface ReferralManagementRow {
  refereeId: string; referrerId: string; code: string; boundAt: string;
  rewardStatus: 'pending' | 'granted' | 'skipped'; skipReason: string | null; orderId: string | null;
  referrerCredits: number | null; refereeCredits: number | null; rewardedAt: string | null; codeDisabled: boolean;
}

const MANAGEMENT_FILTERS = ['page', 'pageSize', 'referrerId', 'refereeId', 'code', 'status'];
const ID = /^[A-Za-z0-9_-]{1,191}$/;

/**
 * Codes, claims and read models of the referral programme. Identity always comes from the session;
 * the code a browser sends is only a hint. Rewards are granted by `ReferralRewards`.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Inject(REFERRAL_OPTIONS) private readonly options: ReferralOptions,
    @Optional() private readonly policies?: PolicyService,
    @Optional() private readonly settings?: ConnectionSettingsService) {}

  now(): Date { return this.options.now?.() ?? new Date(); }

  /**
   * Policy on, and no external affiliate tool (Affonso, PromoteKit) enabled on the public website:
   * the two attribution systems are mutually exclusive. An unreadable website configuration fails
   * closed (`unavailable`): no claim and no reward while it cannot be checked.
   */
  async availability(): Promise<ReferralAvailability> {
    const policy = await readReferralPolicy(this.policies);
    if (!policy.enabled) return { enabled: false, reason: 'disabled' };
    if (this.settings) {
      try {
        const { connections } = await this.settings.publicIntegrations();
        if (connections.enabled && (connections.affonso?.enabled || connections.promoteKit?.enabled)) return { enabled: false, reason: 'external-affiliate' };
      } catch (error) {
        this.logger.warn(`Website integrations could not be read (${error instanceof Error ? error.name : 'Error'}); referrals are paused`);
        return { enabled: false, reason: 'unavailable' };
      }
    }
    return { enabled: true, policy };
  }

  async me(userId: string): Promise<ReferralMeView | { enabled: false; reason: ReferralUnavailableReason }> {
    const available = await this.availability();
    if (!available.enabled) return { enabled: false, reason: available.reason };
    const code = await this.ensureCode(userId);
    return this.database.transaction(async tx => {
      const stats = (await tx.query<{ invited: number; rewarded: number; credits: string }>(`SELECT
          (SELECT COUNT(*)::int FROM referral_bindings WHERE "referrerId" = $1) AS invited,
          (SELECT COUNT(*)::int FROM referral_rewards WHERE "referrerId" = $1 AND status = 'granted') AS rewarded,
          (SELECT COALESCE(SUM("referrerCredits"), 0)::text FROM referral_rewards WHERE "referrerId" = $1 AND status = 'granted') AS credits`, [userId])).rows[0];
      const recent = await tx.query<{ boundAt: Date; status: string | null }>(`SELECT binding."boundAt", reward.status FROM referral_bindings AS binding
        LEFT JOIN referral_rewards AS reward ON reward."refereeId" = binding."refereeId"
        WHERE binding."referrerId" = $1 ORDER BY binding."boundAt" DESC, binding."refereeId" LIMIT 10`, [userId]);
      return {
        enabled: true as const, code: code.code, codeActive: !code.disabledAt,
        link: !code.disabledAt && this.options.webOrigin ? `${this.options.webOrigin}/?ref=${code.code}` : null,
        stats: { invited: stats.invited, rewarded: stats.rewarded, creditsEarned: Number(stats.credits) },
        recent: recent.rows.map(row => ({ boundAt: row.boundAt.toISOString(),
          status: row.status === 'granted' ? 'granted' as const : row.status === 'skipped' ? 'skipped' as const : 'pending' as const })),
      };
    });
  }

  /** Returns the user's code, creating it on first use (retries the rare collision with another code). */
  async ensureCode(userId: string, disabled = false): Promise<{ code: string; disabledAt: Date | null }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const found = await this.database.transaction(async tx => {
        // ON CONFLICT without a target absorbs both a concurrent first read (userId) and a code collision.
        await tx.query(`INSERT INTO referral_codes ("userId", code, "disabledAt") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [userId, generateReferralCode(), disabled ? this.now() : null]);
        return (await tx.query<{ code: string; disabledAt: Date | null }>('SELECT code, "disabledAt" FROM referral_codes WHERE "userId" = $1', [userId])).rows[0];
      });
      if (found) return found;
    }
    throw new Error('Referral code could not be allocated');
  }

  /**
   * Binds the caller to the owner of `code`. Every rule failure is the same 400
   * `REFERRAL_NOT_APPLICABLE`. Replaying a claim that already bound the caller with the same code
   * succeeds again (a lost response is safe to retry); one binding per referee is the primary key.
   */
  async claim(userId: string, body: unknown): Promise<{ bound: true }> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'code')) throw referralNotApplicable();
    const code = normalizeReferralCode((body as { code?: unknown }).code);
    if (!code) throw referralNotApplicable();
    const available = await this.availability();
    if (!available.enabled) throw referralNotApplicable();
    const now = this.now(), windowStart = new Date(now.getTime() - available.policy.claimWindowDays * DAY_MS);
    const bound = await this.database.transaction(async tx => {
      const existing = (await tx.query<{ code: string }>('SELECT code FROM referral_bindings WHERE "refereeId" = $1', [userId])).rows[0];
      if (existing) return existing.code === code;
      const owner = (await tx.query<{ userId: string; status: boolean }>(`SELECT owner."userId", users.status FROM referral_codes AS owner
        JOIN users ON users.id = owner."userId" WHERE owner.code = $1 AND owner."disabledAt" IS NULL`, [code])).rows[0];
      // Self-referral, and a referral ring of two (the code owner was referred by the caller), are refused.
      if (!owner || !owner.status || owner.userId === userId) return false;
      const facts = (await tx.query<{ createTime: Date | null; status: boolean; ordered: boolean; mutual: boolean }>(`SELECT users."createTime", users.status,
          EXISTS (SELECT 1 FROM billing_orders WHERE "ownerId" = users.id AND "fulfilledAt" IS NOT NULL) AS ordered,
          EXISTS (SELECT 1 FROM referral_bindings WHERE "refereeId" = $2 AND "referrerId" = users.id) AS mutual
        FROM users WHERE users.id = $1`, [userId, owner.userId])).rows[0];
      if (!facts?.status || !facts.createTime || facts.createTime < windowStart || facts.ordered || facts.mutual) return false;
      const inserted = await tx.query(`INSERT INTO referral_bindings ("refereeId", "referrerId", code, "boundAt") VALUES ($1, $2, $3, $4)
        ON CONFLICT ("refereeId") DO NOTHING RETURNING "refereeId"`, [userId, owner.userId, code, now]);
      if (inserted.rows.length) return true;
      // A concurrent claim won: succeed only if it bound the same code.
      return (await tx.query<{ code: string }>('SELECT code FROM referral_bindings WHERE "refereeId" = $1', [userId])).rows[0]?.code === code;
    });
    if (!bound) throw referralNotApplicable();
    return { bound: true };
  }

  /** `{ data, total, page, pageSize }` of bindings with their reward decision (back office only). */
  async list(query: Record<string, unknown>): Promise<{ data: ReferralManagementRow[]; total: number; page: number; pageSize: number }> {
    if (Object.keys(query).some(key => !MANAGEMENT_FILTERS.includes(key))) throw new BadRequestException('Unsupported referral filter');
    const integer = (value: unknown, fallback: number, max: number) => {
      if (value === undefined || value === '') return fallback;
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new BadRequestException('Invalid referral page');
      return number;
    };
    const page = integer(query.page, 1, 100_000), pageSize = integer(query.pageSize, 20, 100);
    const where: string[] = [], values: unknown[] = [];
    for (const key of ['referrerId', 'refereeId'] as const) {
      if (query[key] === undefined || query[key] === '') continue;
      if (typeof query[key] !== 'string' || !ID.test(query[key])) throw new BadRequestException('Invalid referral filter');
      values.push(query[key]); where.push(`binding."${key}" = $${values.length}`);
    }
    if (query.code !== undefined && query.code !== '') {
      const code = normalizeReferralCode(query.code);
      if (!code) throw new BadRequestException('Invalid referral filter');
      values.push(code); where.push(`binding.code = $${values.length}`);
    }
    if (query.status !== undefined && query.status !== '') {
      if (query.status === 'pending') where.push('reward."refereeId" IS NULL');
      else if (query.status === 'granted' || query.status === 'skipped') { values.push(query.status); where.push(`reward.status = $${values.length}`); }
      else throw new BadRequestException('Invalid referral filter');
    }
    const from = `FROM referral_bindings AS binding LEFT JOIN referral_rewards AS reward ON reward."refereeId" = binding."refereeId"
      LEFT JOIN referral_codes AS code ON code."userId" = binding."referrerId" ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    return this.database.transaction(async tx => {
      const total = (await tx.query<{ total: number }>(`SELECT COUNT(*)::int AS total ${from}`, values)).rows[0].total;
      const rows = await tx.query<{ refereeId: string; referrerId: string; code: string; boundAt: Date; status: string | null; skipReason: string | null;
        orderId: string | null; referrerCredits: number | null; refereeCredits: number | null; createdAt: Date | null; disabledAt: Date | null }>(
        `SELECT binding."refereeId", binding."referrerId", binding.code, binding."boundAt", reward.status, reward."skipReason", reward."orderId",
          reward."referrerCredits", reward."refereeCredits", reward."createdAt", code."disabledAt"
        ${from} ORDER BY binding."boundAt" DESC, binding."refereeId" LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values);
      return { total, page, pageSize, data: rows.rows.map(row => ({
        refereeId: row.refereeId, referrerId: row.referrerId, code: row.code, boundAt: row.boundAt.toISOString(),
        rewardStatus: row.status === 'granted' || row.status === 'skipped' ? row.status : 'pending', skipReason: row.skipReason, orderId: row.orderId,
        referrerCredits: row.referrerCredits, refereeCredits: row.refereeCredits, rewardedAt: row.createdAt?.toISOString() ?? null,
        codeDisabled: !!row.disabledAt,
      })) };
    });
  }

  /**
   * Disables or re-enables one user's code (`{ disabled: boolean }`), with an `operationLogs` row in the
   * same transaction. Disabling a user who has no code yet allocates one in the disabled state, so the
   * user cannot obtain a fresh one. 404 for an unknown user.
   */
  async setCodeDisabled(actorId: string, userId: string, body: unknown): Promise<{ userId: string; code: string; disabled: boolean }> {
    if (!ID.test(userId)) throw new NotFoundException();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'disabled')
      || typeof (body as { disabled?: unknown }).disabled !== 'boolean') throw new BadRequestException('Body must be { disabled: boolean }');
    const disabled = (body as { disabled: boolean }).disabled;
    const user = await this.database.transaction(tx => tx.query('SELECT id FROM users WHERE id = $1', [userId]));
    if (!user.rows.length) throw new NotFoundException();
    await this.ensureCode(userId, disabled);
    return this.database.transaction(async tx => {
      const updated = (await tx.query<{ code: string; disabledAt: Date | null }>(`UPDATE referral_codes
        SET "disabledAt" = CASE WHEN $2::boolean THEN COALESCE("disabledAt", $3) ELSE NULL END WHERE "userId" = $1 RETURNING code, "disabledAt"`,
      [userId, disabled, this.now()])).rows[0];
      if (!updated) throw new NotFoundException();
      await this.audit(tx, actorId, userId, disabled);
      return { userId, code: updated.code, disabled: !!updated.disabledAt };
    });
  }

  private audit(tx: ApplicationTransaction, actorId: string, userId: string, disabled: boolean) {
    return tx.model('operationLogs').create({ data: { module: 'referrals', action: disabled ? 'disable-code' : 'enable-code', status: 'SUCCESS',
      userId: actorId, targetId: userId, targetType: 'referral-code', method: 'PATCH', path: `/management/referrals/codes/${userId}`,
      metadata: { disabled } } });
  }
}
