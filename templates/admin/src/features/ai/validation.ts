/**
 * Field rules shared by the AI pricing and catalog editors. They mirror what the server accepts (WP 2.3
 * contract): credit amounts are integers that fit the ledger's positive 32-bit range (0 = free), chat
 * token rates may carry up to four decimals, and model/provider ids are short printable identifiers.
 * The server re-validates every write; these checks only give the administrator early feedback.
 */
export type IssueCode =
  | 'required'
  | 'integer'
  | 'decimal'
  | 'tooLarge'
  | 'modelFormat'
  | 'providerFormat'
  | 'labelFormat'
  | 'duplicate'
  | 'tooMany';

/** Largest credit amount the ledger accepts (`2^31 - 1`). */
export const MAX_CREDITS = 2_147_483_647;
/** Upper bound for a per-1k-token rate. */
export const MAX_TOKEN_RATE = 1_000_000;
/** Rows per kind; keeps each policy field well under the server's 16 KiB JSON limit. */
export const MAX_ROWS = 100;

const INTEGER = /^\d+$/;
const DECIMAL = /^\d+(?:\.\d{1,4})?$/;
/** e.g. `gpt-image-1`, `black-forest-labs/flux-schnell`, `stability:sd3`, `imagen@002`. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** Provider ids as registered by the AI connections, e.g. `openai`, `gemini-image`, `replicate`. */
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_LABEL = 80;

export type Checked<T> = { ok: true; value: T } | { ok: false; issue: IssueCode };

/** Non-negative whole credits. */
export function checkCredits(raw: string): Checked<number> {
  const text = raw.trim();
  if (!text) return { ok: false, issue: 'required' };
  if (!INTEGER.test(text)) return { ok: false, issue: 'integer' };
  const value = Number(text);
  return value > MAX_CREDITS ? { ok: false, issue: 'tooLarge' } : { ok: true, value };
}

/** Non-negative decimal with at most four fractional digits. */
export function checkRate(raw: string): Checked<number> {
  const text = raw.trim();
  if (!text) return { ok: false, issue: 'required' };
  if (!DECIMAL.test(text)) return { ok: false, issue: 'decimal' };
  const value = Number(text);
  return value > MAX_TOKEN_RATE ? { ok: false, issue: 'tooLarge' } : { ok: true, value };
}

export function checkModel(raw: string): Checked<string> {
  const text = raw.trim();
  if (!text) return { ok: false, issue: 'required' };
  return MODEL.test(text) ? { ok: true, value: text } : { ok: false, issue: 'modelFormat' };
}

export function checkProvider(raw: string): Checked<string> {
  const text = raw.trim();
  if (!text) return { ok: false, issue: 'required' };
  return PROVIDER.test(text) ? { ok: true, value: text } : { ok: false, issue: 'providerFormat' };
}

/** Optional display label; empty means "use the model id". */
export function checkLabel(raw: string): Checked<string> {
  const text = raw.trim();
  return text.length > MAX_LABEL || CONTROL.test(text) ? { ok: false, issue: 'labelFormat' } : { ok: true, value: text };
}

/** Draft text for a stored number (anything else is shown as-is so validation can flag it). */
export function numberDraft(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'number' || typeof value === 'string' ? String(value) : JSON.stringify(value);
}

let sequence = 0;
/** Stable React key for an editable row. */
export const rowId = () => `row-${++sequence}`;

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
