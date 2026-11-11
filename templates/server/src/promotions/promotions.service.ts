import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { parsePackOfferId, parsePlanOfferId, type HostedCheckoutOffer, type HostedCheckoutPromotion, type HostedCheckoutSelection } from '@zucker-framework/payment';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { BillingService, promoInvalid, type BillingPromotions } from '../billing/billing.service';
import { computePromotion, offerTargets, parsePromotion, promotionApplies, PROMOTION_FIELDS, revision,
  type PromotionInput, type PromotionRow } from './promotions.validation';

/**
 * How long a reserved use counts while its order is unpaid. Longer than a hosted checkout stays
 * payable (Stripe sessions expire after 24 h by default), so an open checkout keeps its slot. An
 * order the provider reported expired/unpaid frees it at once. A payment that still arrives after
 * the slot was reused is honoured: the buyer paid the price the server froze.
 */
export const PROMOTION_RESERVATION_TTL_MS = 25 * 60 * 60 * 1000;
const PAGE_SIZE = 20;

interface RedemptionRow {
  orderId: string; promotionId: string; ownerId: string; providerId: string; status: 'reserved' | 'redeemed';
  reference: string | null; discountAmount: string; payableAmount: string; currency: string;
  expiresAt: Date; redeemedAt: Date | null; createdAt: Date;
}

function page(value: unknown): number {
  const number = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 10000) throw new BadRequestException('Invalid page');
  return number;
}
function size(value: unknown): number {
  const number = value === undefined ? PAGE_SIZE : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100) throw new BadRequestException('Invalid page size');
  return number;
}
function uniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';
}

/** Promo codes: checkout reservation/freezing (the billing port) and back-office management. */
@Injectable()
export class PromotionsService implements BillingPromotions {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly billing: BillingService) {
    billing.usePromotions(this);
  }

  // ─── Checkout ──────────────────────────────────────────────────────────────

  async apply(selection: Readonly<HostedCheckoutSelection>, offer: HostedCheckoutOffer): Promise<HostedCheckoutOffer> {
    const now = new Date();
    const targets = offerTargets(selection.offerId, { plan: parsePlanOfferId(selection.offerId)?.planId ?? null,
      pack: parsePackOfferId(selection.offerId)?.packId ?? null });
    const promotions = this.database.model('promotions');
    if (selection.promotionCode !== undefined) {
      const row = await promotions.findUnique({ where: { alias: selection.promotionCode } }) as PromotionRow | null;
      const frozen = row ? await this.reserve(row.id, selection, offer, targets, now) : null;
      return frozen ? { ...offer, promotion: frozen } : promoInvalid();
    }
    // Automatic promotions apply to one-time offers only: a subscription needs a once-only provider
    // coupon, and a misconfigured automatic one must not block every subscription checkout.
    if (offer.mode !== 'payment') return offer;
    const candidates = (await promotions.findMany({ where: { alias: null, status: 'active', providerId: selection.providerId,
      target: { in: targets } }, take: 50 }) as PromotionRow[])
      .filter(row => promotionApplies(row, selection.providerId, targets, offer.money.currency, now))
      .map(row => ({ row, frozen: computePromotion(row, offer) }))
      .filter((item): item is { row: PromotionRow; frozen: HostedCheckoutPromotion } => !!item.frozen)
      // Largest discount first; ties by id so the choice is deterministic.
      .sort((a, b) => Number(b.frozen.discount.amount) - Number(a.frozen.discount.amount) || a.row.id.localeCompare(b.row.id));
    for (const { row } of candidates) {
      const frozen = await this.reserve(row.id, selection, offer, targets, now);
      if (frozen) return { ...offer, promotion: frozen };
    }
    return offer;
  }

  /**
   * Under a row lock on the promotion: re-read it, recompute the discount, count live uses and
   * insert this order's reservation. Concurrent creates of a code with N uses left get exactly N.
   * A retry of the same order (same idempotency key) reuses its reservation.
   */
  private reserve(id: string, selection: Readonly<HostedCheckoutSelection>, offer: HostedCheckoutOffer,
    targets: readonly string[], now: Date): Promise<HostedCheckoutPromotion | null> {
    return this.database.transaction(async tx => {
      const locked = await tx.query<{ id: string }>('SELECT "id" FROM promotions WHERE "id"=$1 FOR UPDATE', [id]);
      if (!locked.rows.length) return null;
      const row = await tx.model('promotions').findUnique({ where: { id } }) as PromotionRow | null;
      if (!row || !promotionApplies(row, selection.providerId, targets, offer.money.currency, now)) return null;
      const frozen = computePromotion(row, offer);
      if (!frozen) return null;
      const redemptions = tx.model('promotionRedemptions');
      const existing = await redemptions.findUnique({ where: { orderId: selection.orderId } }) as RedemptionRow | null;
      if (existing) {
        if (existing.ownerId !== selection.ownerId) return null;
        if (existing.promotionId === row.id && existing.status === 'reserved' && existing.expiresAt > now) return frozen;
        // A reservation left by an earlier attempt of this not-yet-created order (another code) is replaced.
        if (existing.status !== 'reserved') return null;
        await redemptions.delete({ where: { orderId: selection.orderId } });
      }
      if (row.maxRedemptions !== null && await this.liveUses(tx, row.id, now) >= row.maxRedemptions) return null;
      await redemptions.create({ data: { orderId: selection.orderId, promotionId: row.id, ownerId: selection.ownerId,
        providerId: selection.providerId, status: 'reserved', discountAmount: frozen.discount.amount,
        payableAmount: frozen.payable.amount, currency: frozen.payable.currency,
        expiresAt: new Date(now.getTime() + PROMOTION_RESERVATION_TTL_MS) } });
      return frozen;
    });
  }

  /** Redeemed uses plus reservations still holding a slot (not expired, order not reported unpaid). */
  private async liveUses(tx: ApplicationTransaction, promotionId: string, now: Date): Promise<number> {
    const { rows } = await tx.query<{ used: number }>(`SELECT count(*)::int AS used FROM promotion_redemptions r
      WHERE r."promotionId"=$1 AND (r."status"='redeemed' OR (r."status"='reserved' AND r."expiresAt" > $2
        AND NOT EXISTS (SELECT 1 FROM billing_orders o WHERE o."id"=r."orderId" AND o."state"='unpaid')))`, [promotionId, now]);
    return rows[0]?.used ?? 0;
  }

  async release(orderId: string): Promise<void> {
    await this.database.transaction(tx => tx.query(`DELETE FROM promotion_redemptions WHERE "orderId"=$1 AND "status"='reserved'
      AND NOT EXISTS (SELECT 1 FROM billing_orders WHERE "id"=$1) RETURNING "orderId"`, [orderId]));
  }

  // ─── Management ────────────────────────────────────────────────────────────

  private async usage(ids: readonly string[]): Promise<Map<string, { redeemed: number; reserved: number }>> {
    const result = new Map<string, { redeemed: number; reserved: number }>();
    if (!ids.length) return result;
    const { rows } = await this.database.transaction(tx => tx.query<{ promotionId: string; status: string; count: number }>(
      `SELECT "promotionId", "status", count(*)::int AS count FROM promotion_redemptions
       WHERE "promotionId" = ANY($1::text[]) AND ("status"='redeemed' OR "expiresAt" > now()) GROUP BY "promotionId", "status"`, [ids]));
    for (const row of rows) {
      const entry = result.get(row.promotionId) ?? { redeemed: 0, reserved: 0 };
      if (row.status === 'redeemed') entry.redeemed = row.count; else entry.reserved = row.count;
      result.set(row.promotionId, entry);
    }
    return result;
  }
  private view(row: PromotionRow, usage = { redeemed: 0, reserved: 0 }) {
    return { id: row.id, alias: row.alias, providerId: row.providerId, providerCode: row.providerCode, target: row.target,
      currency: row.currency, discountType: row.discountType, percentOff: row.percentOff, amountOff: row.amountOff,
      maxRedemptions: row.maxRedemptions, status: row.status, startsAt: row.startsAt, endsAt: row.endsAt, note: row.note,
      revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, usage };
  }

  async list(query: Record<string, unknown>) {
    const current = page(query.page), pageSize = size(query.pageSize);
    const where: Record<string, unknown> = {};
    if (query.status !== undefined) {
      if (query.status !== 'active' && query.status !== 'disabled') throw new BadRequestException('Invalid status filter');
      where.status = query.status;
    }
    if (query.q !== undefined) {
      if (typeof query.q !== 'string' || query.q.length > 64) throw new BadRequestException('Invalid search');
      if (query.q.trim()) where.OR = [{ alias: { contains: query.q.trim().toUpperCase() } }, { providerCode: { contains: query.q.trim() } },
        { note: { contains: query.q.trim(), mode: 'insensitive' } }];
    }
    const model = this.database.model('promotions');
    const [rows, total] = await Promise.all([
      model.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (current - 1) * pageSize, take: pageSize }) as Promise<PromotionRow[]>,
      model.count({ where }),
    ]);
    const usage = await this.usage(rows.map(row => row.id));
    return { data: rows.map(row => this.view(row, usage.get(row.id))), total, page: current, pageSize };
  }
  private async row(id: string): Promise<PromotionRow> {
    const row = typeof id === 'string' && id.length <= 64
      ? await this.database.model('promotions').findUnique({ where: { id } }) as PromotionRow | null : null;
    if (!row) throw new NotFoundException('Promotion not found');
    return row;
  }
  async get(id: string) {
    const row = await this.row(id);
    return this.view(row, (await this.usage([row.id])).get(row.id));
  }
  async redemptions(id: string, query: Record<string, unknown>) {
    const row = await this.row(id), current = page(query.page), pageSize = size(query.pageSize), model = this.database.model('promotionRedemptions');
    const where = { promotionId: row.id };
    const [data, total] = await Promise.all([
      model.findMany({ where, orderBy: [{ createdAt: 'desc' }, { orderId: 'desc' }], skip: (current - 1) * pageSize, take: pageSize }) as Promise<RedemptionRow[]>,
      model.count({ where }),
    ]);
    return { data: data.map(item => ({ orderId: item.orderId, ownerId: item.ownerId, providerId: item.providerId, status: item.status,
      reference: item.reference, discount: { amount: item.discountAmount, currency: item.currency },
      payable: { amount: item.payableAmount, currency: item.currency }, expiresAt: item.expiresAt, redeemedAt: item.redeemedAt,
      createdAt: item.createdAt })), total, page: current, pageSize };
  }

  /** The target must name an existing plan, credit pack or currently sold static offer. */
  private async assertTarget(tx: ApplicationTransaction, target: string): Promise<void> {
    if (target === '*') return;
    const [kind, id] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
    const exists = kind === 'plan' ? !!await tx.model('subscriptionPlans').findUnique({ where: { id } })
      : kind === 'pack' ? !!await tx.model('creditPacks').findUnique({ where: { id } })
        : (await this.billing.catalog.list()).some(offer => offer.id === id);
    if (!exists) throw new BadRequestException('target does not name an existing plan, pack or offer');
  }
  private async audit(tx: ApplicationTransaction, actorId: string, action: string, id: string, method: string, metadata: Record<string, unknown>) {
    await tx.model('operationLogs').create({ data: { module: 'promotions', action, status: 'SUCCESS', userId: actorId,
      targetId: id, targetType: 'promotion', method, path: `/management/promotions/${id}`, metadata } });
  }
  private async write<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (uniqueViolation(error)) throw new ConflictException('A promotion with this alias already exists');
      throw error;
    }
  }

  async create(actorId: string, body: unknown) {
    const { input } = parsePromotion(body, false);
    return this.write(() => this.database.transaction(async tx => {
      await this.assertTarget(tx, input.target);
      const row = await tx.model('promotions').create({ data: { ...input } }) as PromotionRow;
      await this.audit(tx, actorId, 'create', row.id, 'POST', { revision: row.revision, alias: row.alias, target: row.target });
      return this.view(row);
    }));
  }
  async update(actorId: string, id: string, body: unknown) {
    const { input, expectedRevision } = parsePromotion(body, true);
    return this.write(() => this.database.transaction(async tx => {
      const current = await this.locked(tx, id, expectedRevision!);
      await this.assertTarget(tx, input.target);
      const changedFields = PROMOTION_FIELDS.filter(key => JSON.stringify(current[key]) !== JSON.stringify(input[key as keyof PromotionInput]));
      const row = await tx.model('promotions').update({ where: { id: current.id }, data: { ...input, revision: { increment: 1 } } }) as PromotionRow;
      await this.audit(tx, actorId, 'update', row.id, 'PUT', { revision: row.revision, changedFields });
      return this.view(row);
    }));
  }
  async status(actorId: string, id: string, body: unknown) {
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (Object.keys(raw).some(key => key !== 'status' && key !== 'expectedRevision')
      || (raw.status !== 'active' && raw.status !== 'disabled')) throw new BadRequestException('Invalid promotion status');
    const expectedRevision = revision(raw.expectedRevision);
    return this.database.transaction(async tx => {
      const current = await this.locked(tx, id, expectedRevision);
      const row = await tx.model('promotions').update({ where: { id: current.id }, data: { status: raw.status, revision: { increment: 1 } } }) as PromotionRow;
      await this.audit(tx, actorId, 'status', row.id, 'POST', { revision: row.revision, from: current.status, to: row.status });
      return this.view(row);
    });
  }
  /** Only a promotion that was never reserved or redeemed can be deleted; otherwise disable it. */
  async remove(actorId: string, id: string, expected: unknown) {
    const expectedRevision = revision(typeof expected === 'string' && /^\d{1,15}$/.test(expected) ? Number(expected) : expected);
    return this.database.transaction(async tx => {
      const current = await this.locked(tx, id, expectedRevision);
      if (await tx.model('promotionRedemptions').count({ where: { promotionId: current.id } }))
        throw new ConflictException('This promotion has been used; disable it instead of deleting it');
      await tx.model('promotions').delete({ where: { id: current.id } });
      await this.audit(tx, actorId, 'delete', current.id, 'DELETE', { revision: current.revision, alias: current.alias });
      return { id: current.id, deleted: true };
    });
  }
  /** Lock the row (the same lock checkout reservations take) and compare the revision. */
  private async locked(tx: ApplicationTransaction, id: string, expectedRevision: number): Promise<PromotionRow> {
    if (typeof id !== 'string' || id.length > 64) throw new NotFoundException('Promotion not found');
    await tx.query('SELECT "id" FROM promotions WHERE "id"=$1 FOR UPDATE', [id]);
    const row = await tx.model('promotions').findUnique({ where: { id } }) as PromotionRow | null;
    if (!row) throw new NotFoundException('Promotion not found');
    if (row.revision !== expectedRevision) throw new ConflictException('Promotion changed; reload before saving');
    return row;
  }
}
