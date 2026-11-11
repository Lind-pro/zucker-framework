import { BadRequestException } from '@nestjs/common';
import { fromMinorUnits, toMinorUnits, type HostedCheckoutOffer, type HostedCheckoutPromotion } from '@zucker-framework/payment';

export const PROMOTION_ALIAS = /^[A-Z0-9_-]{3,32}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const PROVIDER_CODE = /^[A-Za-z0-9_-]{1,128}$/;
const TARGET = /^(\*|(plan|pack|offer):[A-Za-z0-9_-]{1,64})$/;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const MAX_REDEMPTIONS = 1_000_000;

export type PromotionStatus = 'active' | 'disabled';
export type PromotionDiscountType = 'percent' | 'amount';

/** A `promotions` row (models/promotions.prisma). */
export interface PromotionRow {
  id: string; alias: string | null; providerId: string; providerCode: string; target: string;
  currency: string | null; discountType: PromotionDiscountType; percentOff: number | null; amountOff: string | null;
  maxRedemptions: number | null; status: PromotionStatus; startsAt: Date | null; endsAt: Date | null; note: string | null;
  revision: number; createdAt: Date; updatedAt: Date;
}

/** Editable fields, validated (write body minus `expectedRevision`). */
export interface PromotionInput {
  alias: string | null; providerId: string; providerCode: string; target: string; currency: string | null;
  discountType: PromotionDiscountType; percentOff: number | null; amountOff: string | null; maxRedemptions: number | null;
  status: PromotionStatus; startsAt: Date | null; endsAt: Date | null; note: string | null;
}
export const PROMOTION_FIELDS = ['alias', 'providerId', 'providerCode', 'target', 'currency', 'discountType', 'percentOff',
  'amountOff', 'maxRedemptions', 'status', 'startsAt', 'endsAt', 'note'] as const;

function bad(message: string): never { throw new BadRequestException(message); }
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('Invalid promotion request');
  return value as Record<string, unknown>;
}
function date(value: unknown, label: string): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) bad(`${label} must be an ISO timestamp with a zone`);
  return new Date(value);
}
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) bad('expectedRevision is required');
  return value;
}

/**
 * Exact keys; every field is required on create and update (`null` clears an optional one) so an
 * edit never depends on what the client happened to omit.
 */
export function parsePromotion(body: unknown, withRevision: boolean): { input: PromotionInput; expectedRevision: number | null } {
  const raw = plain(body);
  const allowed = new Set<string>([...PROMOTION_FIELDS, ...(withRevision ? ['expectedRevision'] : [])]);
  if (Object.keys(raw).some(key => !allowed.has(key))) bad('Unknown promotion field');
  const alias = raw.alias === null || raw.alias === undefined ? null
    : typeof raw.alias === 'string' && PROMOTION_ALIAS.test(raw.alias.trim().toUpperCase()) ? raw.alias.trim().toUpperCase() : bad('alias must be 3–32 of A–Z, 0–9, _ or -');
  if (typeof raw.providerId !== 'string' || !PROVIDER.test(raw.providerId)) bad('providerId is invalid');
  if (typeof raw.providerCode !== 'string' || !PROVIDER_CODE.test(raw.providerCode)) bad('providerCode must be 1–128 of A–Z, a–z, 0–9, _ or -');
  if (typeof raw.target !== 'string' || !TARGET.test(raw.target)) bad("target must be '*', 'plan:<id>', 'pack:<id>' or 'offer:<id>'");
  const currency = raw.currency === null || raw.currency === undefined ? null
    : typeof raw.currency === 'string' && CURRENCIES.has(raw.currency) ? raw.currency : bad('currency must be an ISO 4217 code');
  if (raw.discountType !== 'percent' && raw.discountType !== 'amount') bad("discountType must be 'percent' or 'amount'");
  let percentOff: number | null = null, amountOff: string | null = null;
  if (raw.discountType === 'percent') {
    // 100% would make the total zero, which is refused (no money never grants).
    if (typeof raw.percentOff !== 'number' || !Number.isInteger(raw.percentOff) || raw.percentOff < 1 || raw.percentOff > 99) bad('percentOff must be an integer from 1 to 99');
    if (raw.amountOff !== null && raw.amountOff !== undefined) bad('amountOff must be null for a percent discount');
    percentOff = raw.percentOff;
  } else {
    if (!currency) bad('An amount discount requires a currency');
    if (raw.percentOff !== null && raw.percentOff !== undefined) bad('percentOff must be null for an amount discount');
    let minor = 0;
    try { minor = typeof raw.amountOff === 'string' && /^\d+(?:\.\d+)?$/.test(raw.amountOff) ? toMinorUnits(raw.amountOff, currency) : 0; } catch { minor = 0; }
    if (minor <= 0) bad(`amountOff must be a positive exact amount in ${currency}`);
    amountOff = fromMinorUnits(minor, currency);
  }
  const maxRedemptions = raw.maxRedemptions === null || raw.maxRedemptions === undefined ? null
    : typeof raw.maxRedemptions === 'number' && Number.isInteger(raw.maxRedemptions) && raw.maxRedemptions >= 1 && raw.maxRedemptions <= MAX_REDEMPTIONS
      ? raw.maxRedemptions : bad(`maxRedemptions must be null or an integer from 1 to ${MAX_REDEMPTIONS}`);
  const status = raw.status === undefined ? 'active' : raw.status === 'active' || raw.status === 'disabled' ? raw.status : bad("status must be 'active' or 'disabled'");
  const startsAt = date(raw.startsAt, 'startsAt'), endsAt = date(raw.endsAt, 'endsAt');
  if (startsAt && endsAt && endsAt <= startsAt) bad('endsAt must be after startsAt');
  const note = raw.note === null || raw.note === undefined ? null
    : typeof raw.note === 'string' && raw.note.length <= 500 ? raw.note.trim() || null : bad('note must be at most 500 characters');
  return {
    input: { alias, providerId: raw.providerId, providerCode: raw.providerCode, target: raw.target, currency,
      discountType: raw.discountType, percentOff, amountOff, maxRedemptions, status, startsAt, endsAt, note },
    expectedRevision: withRevision ? revision(raw.expectedRevision) : null,
  };
}

/** Targets an offer matches: every offer, then its plan, pack or static offer id. */
export function offerTargets(offerId: string, parsed: { plan: string | null; pack: string | null }): string[] {
  if (parsed.plan) return ['*', `plan:${parsed.plan}`];
  if (parsed.pack) return ['*', `pack:${parsed.pack}`];
  return ['*', `offer:${offerId}`];
}

/** True when the promotion may be used now for this provider, target set and currency. */
export function promotionApplies(row: PromotionRow, providerId: string, targets: readonly string[], currency: string, now: Date): boolean {
  return row.status === 'active' && row.providerId === providerId && targets.includes(row.target)
    && (!row.currency || row.currency === currency)
    && (!row.startsAt || row.startsAt <= now) && (!row.endsAt || row.endsAt > now);
}

/**
 * The discount, computed by the server from the frozen list price: percent rounds half up to the
 * currency's minor unit; an amount discount needs the same currency. Null when it does not apply or
 * would leave nothing to pay (a zero total is refused, never fulfilled).
 */
export function computePromotion(row: PromotionRow, offer: Pick<HostedCheckoutOffer, 'money'>): HostedCheckoutPromotion | null {
  const currency = offer.money.currency;
  if (row.currency && row.currency !== currency) return null;
  const total = toMinorUnits(offer.money.amount, currency);
  let off: number;
  if (row.discountType === 'percent' && row.percentOff) off = Math.floor((total * row.percentOff * 2 + 100) / 200);
  else if (row.discountType === 'amount' && row.amountOff && row.currency === currency) off = toMinorUnits(row.amountOff, currency);
  else return null;
  const pay = total - off;
  if (!Number.isSafeInteger(off) || off <= 0 || pay <= 0) return null;
  return { id: row.id, providerCode: row.providerCode,
    payable: { amount: fromMinorUnits(pay, currency), currency }, discount: { amount: fromMinorUnits(off, currency), currency } };
}
