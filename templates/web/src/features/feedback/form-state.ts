import type { FeedbackSubmit } from './types';

/**
 * Pure helpers for the feedback form (node tests load this file directly, so imports stay relative
 * and framework-free). The server re-validates everything; these checks only explain errors early.
 */
export const FEEDBACK_TYPES = ['bug', 'idea', 'question', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
/** Same limit as the server. */
export const FEEDBACK_MESSAGE_MAX = 4000;

export type FeedbackFormError = 'type' | 'empty' | 'tooLong';
export type FeedbackFailure = 'disabled' | 'tooManyOpen' | 'conflict' | 'invalid' | 'rateLimited' | 'uncertain';

export function validateFeedback(type: string, message: string): FeedbackFormError | null {
  if (!(FEEDBACK_TYPES as readonly string[]).includes(type)) return 'type';
  const trimmed = message.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > FEEDBACK_MESSAGE_MAX) return 'tooLong';
  return null;
}

/**
 * Same-site path to attach, or undefined. Mirrors the server rule: one leading slash, no `//`,
 * backslash, whitespace, control characters, query or fragment (those can carry tokens).
 */
export function safePagePath(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || /[\\?#\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

export function submission(type: FeedbackType, message: string, pagePath: string | null | undefined, locale: string): FeedbackSubmit {
  const path = safePagePath(pagePath);
  return { type, message: message.trim(), ...(path ? { pagePath: path } : {}), locale };
}

/** Maps an `httpClient` failure to the few outcomes the form explains; only `FEEDBACK_*` codes are trusted. */
export function feedbackFailure(error: unknown): FeedbackFailure {
  const value = (error ?? {}) as { status?: unknown; _httpStatus?: unknown; code?: unknown; response?: { data?: { code?: unknown } } };
  const status = typeof value.status === 'number' ? value.status : typeof value._httpStatus === 'number' ? value._httpStatus : undefined;
  const raw = value.response?.data?.code ?? value.code;
  const code = typeof raw === 'string' && /^FEEDBACK_[A-Z_]{1,60}$/.test(raw) ? raw : undefined;
  if (code === 'FEEDBACK_DISABLED') return 'disabled';
  if (code === 'FEEDBACK_TOO_MANY_OPEN') return 'tooManyOpen';
  if (code === 'FEEDBACK_IDEMPOTENCY_CONFLICT') return 'conflict';
  if (status === 429) return 'rateLimited';
  if (status === 403) return 'disabled';
  if (status === 400) return 'invalid';
  return 'uncertain';
}

/** Reads `feedback.enabled` from `GET /site/public/config`; anything unexpected counts as enabled (the server decides). */
export function feedbackEnabled(config: unknown): boolean {
  const policies = (config as { policies?: Record<string, { values?: Record<string, unknown> }> } | null)?.policies;
  return policies?.feedback?.values?.enabled !== false;
}
