import { BadRequestException } from '@nestjs/common';

/**
 * Pure input parsing for the feedback endpoints. Every untrusted value is checked here with exact
 * keys and length limits that mirror the CHECK constraints of migration `20261111010000_feedback`.
 */
export const FEEDBACK_TYPES = ['bug', 'idea', 'question', 'other'] as const;
export const FEEDBACK_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
/** Statuses that count toward the policy's `maxOpenPerUser`. */
export const FEEDBACK_OPEN_STATUSES: readonly FeedbackStatus[] = ['open', 'in_progress'];
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_LIMITS = Object.freeze({ message: 4000, pagePath: 512, locale: 35, userAgent: 256, reply: 2000, staffNote: 2000 });
/** Same shape as the AI task submit key. */
export const FEEDBACK_REQUEST_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Multi-line text may hold line breaks and tabs, never other control characters. */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

export interface FeedbackSubmission { type: FeedbackType; message: string; pagePath: string | null; locale: string | null }
export interface FeedbackUpdate { expectedRevision: number; status?: FeedbackStatus; reply?: string | null; staffNote?: string | null }

const invalid = (field: string, message = `Invalid ${field}`) =>
  new BadRequestException({ code: 'FEEDBACK_INVALID', message, details: { field } });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * A same-site path the user was on: starts with one `/`, no scheme or authority (`//`), no
 * backslash, no whitespace or control characters, no query or fragment (they may carry tokens).
 */
export function isSafePagePath(value: string): boolean {
  return value.length >= 1 && value.length <= FEEDBACK_LIMITS.pagePath && value.startsWith('/') && !value.startsWith('//')
    && !/[\\?#\s]/.test(value) && !ANY_CONTROL.test(value);
}

/** Required text, trimmed, 1..max characters. */
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw invalid(field);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || TEXT_CONTROL.test(trimmed)) throw invalid(field, `${field} must be 1-${max} characters`);
  return trimmed;
}
/** Optional staff text: `null` or `''` clears it. */
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid(field);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max || TEXT_CONTROL.test(trimmed)) throw invalid(field, `${field} must be at most ${max} characters`);
  return trimmed;
}

/** Body `{ type, message, pagePath?, locale? }`. */
export function parseSubmission(body: unknown): FeedbackSubmission {
  if (!record(body) || Object.keys(body).some(key => !['type', 'message', 'pagePath', 'locale'].includes(key))) throw invalid('body', 'Invalid feedback request');
  if (typeof body.type !== 'string' || !(FEEDBACK_TYPES as readonly string[]).includes(body.type)) throw invalid('type');
  const message = text(body.message, 'message', FEEDBACK_LIMITS.message);
  let pagePath: string | null = null;
  if (body.pagePath !== undefined && body.pagePath !== null && body.pagePath !== '') {
    if (typeof body.pagePath !== 'string' || !isSafePagePath(body.pagePath)) throw invalid('pagePath');
    pagePath = body.pagePath;
  }
  let locale: string | null = null;
  if (body.locale !== undefined && body.locale !== null && body.locale !== '') {
    if (typeof body.locale !== 'string' || body.locale.length > FEEDBACK_LIMITS.locale || !LOCALE.test(body.locale)) throw invalid('locale');
    locale = body.locale;
  }
  return { type: body.type as FeedbackType, message, pagePath, locale };
}

/** First language tag of an `Accept-Language` header, when it is a plain tag. */
export function localeFromHeader(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tag = value.split(',')[0]?.split(';')[0]?.trim() ?? '';
  return tag.length <= FEEDBACK_LIMITS.locale && LOCALE.test(tag) ? tag : null;
}

/** Bounded user agent without control characters; diagnostics only, never trusted. */
export function sanitizeUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, FEEDBACK_LIMITS.userAgent).trim();
  return cleaned || null;
}

export function parseRequestKey(value: unknown): string {
  if (typeof value !== 'string' || !FEEDBACK_REQUEST_KEY.test(value))
    throw invalid('idempotencyKey', 'A stable Idempotency-Key (8-128 characters) is required');
  return value;
}

/** Body `{ expectedRevision, status?, reply?, staffNote? }` with at least one change field. */
export function parseUpdate(body: unknown): FeedbackUpdate {
  if (!record(body) || Object.keys(body).some(key => !['expectedRevision', 'status', 'reply', 'staffNote'].includes(key))) throw invalid('body', 'Invalid feedback update');
  const revision = body.expectedRevision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw invalid('expectedRevision');
  const update: FeedbackUpdate = { expectedRevision: revision };
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !(FEEDBACK_STATUSES as readonly string[]).includes(body.status)) throw invalid('status');
    update.status = body.status as FeedbackStatus;
  }
  if (body.reply !== undefined) update.reply = optionalText(body.reply, 'reply', FEEDBACK_LIMITS.reply);
  if (body.staffNote !== undefined) update.staffNote = optionalText(body.staffNote, 'staffNote', FEEDBACK_LIMITS.staffNote);
  if (update.status === undefined && update.reply === undefined && update.staffNote === undefined) throw invalid('body', 'Nothing to update');
  return update;
}

/** `page` / `pageSize` query values (strings), bounded. */
export function pageNumber(value: unknown, fallback: number, max: number, field: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw invalid(field);
  return parsed;
}
