import { readPortError } from '@zucker-framework/fe-types/back-office';

/** Display helpers. They never coerce missing values to zero or invent data. */

export function formatDateTime(value: unknown, locale: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(locale);
}

export function formatDate(value: unknown, locale: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(locale);
}

export interface Money {
  amount: string;
  currency: string;
}

export function isMoney(value: unknown): value is Money {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Money).amount === 'string' &&
    typeof (value as Money).currency === 'string'
  );
}

export const moneyText = (money: Money): string => `${money.amount} ${money.currency}`;

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (isMoney(value)) return moneyText(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Read a dotted path from a record (e.g. `plan.name`). */
export function readPath(record: unknown, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** HTTP status attached by fe-http-client, when present. */
export function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Whether an error is an aborted request (session change, unmount); these are not failures to show. */
export function isAbortError(error: unknown): boolean {
  const value = error as { name?: string; code?: string; message?: string } | null;
  return (
    value?.name === 'CanceledError' ||
    value?.name === 'AbortError' ||
    value?.code === 'ERR_CANCELED' ||
    value?.message === 'canceled'
  );
}

/** Structured fields of an API error body (`PortErrorBody` for back-office ports), when present. */
export interface ErrorBody {
  message?: string;
  reason?: string;
  issues?: string[];
  details?: Record<string, unknown>;
}

/**
 * Read the server's error from an fe-http-client error. Port errors arrive raw
 * (`{ statusCode, message, reason, issues?, details? }`) or inside the template's envelope
 * (`{ status, code, message, result: { reason, issues?, details? } }`); other validation errors may
 * carry a string array in `result`.
 */
export function errorBody(error: unknown): ErrorBody {
  const value = error as { response?: { data?: unknown }; details?: unknown; message?: unknown } | null;
  const data = value?.response?.data;
  const port = readPortError(data);
  const result = data && typeof data === 'object' ? (data as { result?: unknown }).result : undefined;
  const issues =
    port.issues ?? (Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : undefined);
  const flattened = value?.details;
  const details =
    port.details ?? (flattened && typeof flattened === 'object' && !Array.isArray(flattened) ? (flattened as Record<string, unknown>) : undefined);
  const message = port.message ?? (typeof value?.message === 'string' ? value.message : undefined);
  return {
    ...(message ? { message } : {}),
    ...(port.reason ? { reason: port.reason } : {}),
    ...(issues?.length ? { issues } : {}),
    ...(details ? { details } : {}),
  };
}
