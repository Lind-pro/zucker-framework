import type { FieldDefinition, FormDefinition } from './types';
import { FieldType } from './types';

/** Minimal shape of an antd `UploadFile` kept in a FILE field. */
export interface UploadedFileValue {
  uid?: string;
  name?: string;
  url?: string;
  response?: unknown;
  originFileObj?: File;
}

/**
 * Uploads a newly chosen file and returns the value the server should store for it (for example a
 * storage key or URL). Called once per new file at submit time.
 */
export type FormFileUploader = (file: File, field: FieldDefinition) => Promise<unknown>;

interface DateLike {
  format: (template: string) => string;
  toISOString: () => string;
}

function isDateLike(value: unknown): value is DateLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as DateLike).format === 'function' &&
    typeof (value as DateLike).toISOString === 'function'
  );
}

function elementValue(raw: unknown, elementType: string | undefined): unknown {
  if (elementType === FieldType.NUMBER) {
    const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (elementType === FieldType.BOOLEAN) {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    return text === 'true' || text === '1';
  }
  return typeof raw === 'string' ? raw.trim() : raw;
}

function arrayValue(value: unknown, field: FieldDefinition): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        items = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        items = text.split(',');
      }
    } else items = text.split(',');
  } else items = [value];
  // The tag widget holds strings; a chosen option gets its declared value (number/boolean) back
  // when no elementType says how to convert it.
  const optionValues = new Map<string, unknown>();
  if (!field.elementType) for (const option of field.options ?? []) optionValues.set(String(option.value), option.value);
  return items
    .filter((item) => !(typeof item === 'string' && !item.trim()))
    .map((item) =>
      typeof item === 'string' && optionValues.has(item.trim())
        ? optionValues.get(item.trim())
        : elementValue(item, field.elementType),
    );
}

/** A widget value that cannot be converted to the field's server shape (shown on the field). */
export class FormValueError extends Error {
  constructor(readonly fieldKey: string, readonly reason: 'invalid-json' | 'json-not-object') {
    super(`Invalid value for field '${fieldKey}': ${reason}`);
    this.name = 'FormValueError';
  }
}

/** JSON objects or arrays only: the server validates JSON fields with `typeof === 'object'`. */
export function parseJsonFieldText(text: string): { ok: true; value: unknown } | { ok: false; reason: FormValueError['reason'] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'json-not-object' };
  return { ok: true, value: parsed };
}

function jsonValue(value: unknown, field: FieldDefinition): unknown {
  if (typeof value !== 'string') return value;
  if (!value.trim()) return undefined;
  // Usually rejected by the field's validator already; a custom renderer may not have one.
  const parsed = parseJsonFieldText(value);
  if (!parsed.ok) throw new FormValueError(field.key, parsed.reason);
  return parsed.value;
}

async function fileValue(value: unknown, field: FieldDefinition, upload?: FormFileUploader): Promise<unknown> {
  if (value === undefined || value === null) return undefined;
  const list = (Array.isArray(value) ? value : [value]) as UploadedFileValue[];
  const results: unknown[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      results.push(item);
    } else if (item.originFileObj) {
      // Without an uploader the raw File is handed to the caller (e.g. for multipart FormData).
      results.push(upload ? await upload(item.originFileObj, field) : item.originFileObj);
    } else {
      // An already stored file: keep what the server returned for it, else its URL.
      results.push(item.response ?? item.url ?? item.name);
    }
  }
  const maxCount = typeof field.extra?.maxCount === 'number' ? field.extra.maxCount : 1;
  if (maxCount === 1) return results[0];
  return results;
}

/**
 * Convert antd widget values into the shapes `@zucker-framework/form` validates: JSON fields as
 * objects, ARRAY fields as arrays (typed by `elementType`), DATE as `YYYY-MM-DD`, DATETIME as an ISO
 * string and FILE fields as uploaded values. Keys without a field definition are passed through.
 * Throws `FormValueError` for JSON text that is not a JSON object or array.
 */
export async function normalizeFormValues(
  definition: FormDefinition,
  values: Record<string, unknown>,
  uploadFile?: FormFileUploader,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...values };
  for (const field of definition.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const value = values[field.key];
    switch (field.type) {
      case FieldType.JSON:
        result[field.key] = jsonValue(value, field);
        break;
      case FieldType.ARRAY:
        result[field.key] = arrayValue(value, field);
        break;
      case FieldType.FILE:
        result[field.key] = await fileValue(value, field, uploadFile);
        break;
      case FieldType.DATE:
        result[field.key] = isDateLike(value) ? value.format('YYYY-MM-DD') : value;
        break;
      case FieldType.DATETIME:
        result[field.key] = isDateLike(value) ? value.toISOString() : value;
        break;
      default:
        break;
    }
  }
  return result;
}

/**
 * Initial widget values from each field's `defaultValue`. JSON defaults are shown as formatted
 * text, ARRAY defaults as tag lists. DATE/DATETIME defaults are only applied when already a date
 * object (the picker needs a dayjs instance). Caller `initialValues` win over defaults.
 */
export function definitionInitialValues(
  definition: FormDefinition,
  initialValues?: Record<string, unknown>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const value = field.defaultValue;
    if (value === undefined) continue;
    switch (field.type) {
      case FieldType.JSON:
        defaults[field.key] = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        break;
      case FieldType.ARRAY:
        defaults[field.key] = Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : String(item))) : value;
        break;
      case FieldType.DATE:
      case FieldType.DATETIME:
        if (isDateLike(value)) defaults[field.key] = value;
        break;
      case FieldType.FILE:
        break;
      default:
        defaults[field.key] = value;
    }
  }
  const initial: Record<string, unknown> = { ...defaults, ...(initialValues ?? {}) };
  // Caller-supplied JSON objects are edited as text, like defaults.
  for (const field of definition.fields) {
    const value = initial[field.key];
    if (field.type === FieldType.JSON && value !== undefined && value !== null && typeof value !== 'string')
      initial[field.key] = JSON.stringify(value, null, 2);
  }
  return initial;
}
