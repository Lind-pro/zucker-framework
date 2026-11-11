/**
 * Notification types this application emits, with the allow-listed `params` of each.
 *
 * Text is never stored: the web app renders `type` + `params` from `features/inbox/copy.ts`
 * (keep both lists in sync; an unknown type renders a generic line there). Params are numbers and
 * short enumerations only, never free text written by another user (a staff reply, a referee name),
 * so a notification row can neither leak nor inject content.
 */
type ParamSpec = 'count' | readonly string[];

export const AI_TASK_KINDS = ['image', 'video', 'audio'] as const;
export const REFUND_OUTCOMES = ['succeeded'] as const;

export const INBOX_TYPES = Object.freeze({
  /** A one-time order (credit pack or plan) was fulfilled. */
  'order.paid': { credits: 'count' },
  /** A subscription cycle after the first one was paid and its credits granted. */
  'subscription.renewed': { credits: 'count' },
  /** A refund reached its final successful state. */
  'refund.settled': { outcome: REFUND_OUTCOMES },
  'ai.task.completed': { kind: AI_TASK_KINDS },
  'ai.task.failed': { kind: AI_TASK_KINDS },
  /** Staff replied to the user's feedback (WP 3.1). The reply text itself stays on the feedback page. */
  'feedback.replied': {},
  /** Referral credits were granted to this user (WP 3.5a). */
  'referral.rewarded': { credits: 'count' },
} satisfies Record<string, Readonly<Record<string, ParamSpec>>>);

export type InboxNotificationType = keyof typeof INBOX_TYPES;

/** Same-site, locale-free path the web app prefixes with the viewer's locale. */
const HREF = /^\/[A-Za-z0-9\-._~/]*(?:\?[A-Za-z0-9\-._~=&%]*)?(?:#[A-Za-z0-9\-._~]*)?$/;
/** Routed web locales; an href must not carry one (the client adds the viewer's). */
const WEB_LOCALES = new Set(['en', 'zh']);
const EVENT_KEY = /^[A-Za-z0-9][A-Za-z0-9:._\-/]{0,199}$/;
const MAX_PARAMS_BYTES = 2048;
/** Upper bound of a `count` parameter (credits); sources clamp to the same bound (`inbox-sources.ts`). */
export const INBOX_MAX_COUNT = 1_000_000_000;
const MAX_COUNT = INBOX_MAX_COUNT;

export class InboxEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxEmitError';
  }
}

export interface InboxEmitInput {
  userId: string;
  /** Idempotency key per recipient, e.g. `order:<orderId>`; a repeat emit is a no-op. */
  eventKey: string;
  type: InboxNotificationType;
  params?: Record<string, unknown>;
  /** Locale-free same-site path (e.g. `/billing/orders`) or null. */
  href?: string | null;
}

export interface ValidatedInboxEmit {
  userId: string;
  eventKey: string;
  type: InboxNotificationType;
  params: Record<string, number | string>;
  href: string | null;
}

export function isInboxHref(value: string): boolean {
  if (value.length > 512 || !HREF.test(value) || value.startsWith('//') || value.includes('/../') || value.endsWith('/..')) return false;
  const first = value.slice(1).split(/[/?#]/, 1)[0];
  return !WEB_LOCALES.has(first);
}

/** Throws InboxEmitError for anything outside the contract; callers' bugs must not reach the table. */
export function validateInboxEmit(input: InboxEmitInput): ValidatedInboxEmit {
  if (!input || typeof input !== 'object') throw new InboxEmitError('Notification input is required');
  const { userId, eventKey, type } = input;
  if (typeof userId !== 'string' || !userId || userId.length > 200) throw new InboxEmitError('Invalid notification recipient');
  if (typeof eventKey !== 'string' || !EVENT_KEY.test(eventKey)) throw new InboxEmitError('Invalid notification event key');
  if (typeof type !== 'string' || !Object.hasOwn(INBOX_TYPES, type)) throw new InboxEmitError(`Unknown notification type ${String(type).slice(0, 64)}`);
  const spec = INBOX_TYPES[type] as Readonly<Record<string, ParamSpec>>;
  const raw = input.params ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InboxEmitError('Notification params must be an object');
  const params: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const rule = Object.hasOwn(spec, key) ? spec[key] : undefined;
    if (!rule) throw new InboxEmitError(`Parameter ${key.slice(0, 64)} is not allowed for ${type}`);
    if (rule === 'count') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT)
        throw new InboxEmitError(`Parameter ${key} must be a non-negative integer`);
    } else if (typeof value !== 'string' || !rule.includes(value)) {
      throw new InboxEmitError(`Parameter ${key} is not an allowed value`);
    }
    params[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(params)) > MAX_PARAMS_BYTES) throw new InboxEmitError('Notification params are too large');
  const href = input.href ?? null;
  if (href !== null && (typeof href !== 'string' || !isInboxHref(href))) throw new InboxEmitError('Notification link must be a locale-free same-site path');
  return { userId, eventKey, type: type as InboxNotificationType, params, href };
}
