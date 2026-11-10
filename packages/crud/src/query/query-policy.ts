import { BadRequestException } from '@nestjs/common';
import type { ModelFieldInfo } from '@zucker-framework/core';

/**
 * Injection token for the module-wide default {@link CrudQueryPolicy}
 * (`ZuckerCrudModule.forRoot({ queryPolicy })`).
 */
export const CRUD_QUERY_POLICY = 'CRUD_QUERY_POLICY';

/**
 * Policy applied to caller-supplied dynamic queries (filters / terms / where / orderBy /
 * includes / excludes / paging).
 *
 * Secure defaults (no configuration needed):
 * - filter / sort / select field names must be plain scalar identifiers (`[A-Za-z_][A-Za-z0-9_]*`);
 *   `AND`/`OR`/`NOT`, dotted paths and prototype keys are rejected with 400;
 * - relation fields are never selected, sorted or filtered unless explicitly allow-listed
 *   (`selectableFields` for includes, `rawFilterFields` for filters). When the adapter reports
 *   field metadata (`DatabaseAdapter.getModelFields`, implemented by `PrismaAdapter`), relation
 *   and unknown fields are rejected with 400. Without metadata, included values that look like
 *   relation rows (non-null objects other than Date / Buffer / Decimal / arrays of primitives)
 *   are stripped from results; JSON columns then need an explicit `selectableFields` entry;
 * - fields matching {@link DEFAULT_SENSITIVE_FIELD_PATTERN} (password, secret, token hash, ...)
 *   cannot be filtered, sorted or selected. The pattern is a name-based deny-list and cannot
 *   know every secret column: configure `filterableFields` / `selectableFields` allow-lists to
 *   close filter oracles on models with secrets;
 * - unknown operators are rejected with 400 (no raw Prisma fragment passthrough);
 * - filter values must be primitives, Dates or arrays of those (no relation filters);
 * - `pageSize` is clamped to `maxPageSize` and unpaged reads are limited to `maxUnpagedRows`.
 *
 * Every allow-list is optional; when set, only the listed fields are accepted.
 */
export interface CrudQueryPolicy {
  /** Fields accepted in filters / terms / where. Default: any non-sensitive scalar identifier. */
  filterableFields?: readonly string[];
  /** Fields accepted in orderBy. Default: any non-sensitive scalar identifier. */
  sortableFields?: readonly string[];
  /**
   * Fields accepted in `includes`. Default: any non-sensitive scalar field. Relation fields are
   * only selectable when listed here (the whole related row is returned, so list only relations
   * whose every column is safe for the caller).
   */
  selectableFields?: readonly string[];
  /** Extra fields that are never filterable, sortable or selectable. */
  deniedFields?: readonly string[];
  /** Override the sensitive-field name pattern; `false` disables the pattern check. */
  sensitiveFieldPattern?: RegExp | false;
  /** Restrict accepted operators (canonical names such as `eq`, `like`, `in`). Default: all built-ins. */
  allowedOperators?: readonly string[];
  /**
   * Explicit opt-in to the legacy raw passthrough for these fields: object values (e.g. Prisma
   * relation filters such as `{ some: {...} }`) and unknown operators are forwarded as `{ [field]: value }`.
   * Only list fields whose every related column is safe for the caller to probe.
   */
  rawFilterFields?: readonly string[];
  /** Upper bound for `pageSize` (clamped). Default 1000. */
  maxPageSize?: number;
  /** Row limit for unpaged reads (`take`). Default 10000. `Infinity` disables the limit. */
  maxUnpagedRows?: number;
  /** Maximum number of filter conditions per query. Default 200. */
  maxFilterConditions?: number;
  /** Maximum nesting depth of `$nest` / `$orNest` / nested terms. Default 8. */
  maxFilterDepth?: number;
}

export const DEFAULT_MAX_PAGE_SIZE = 1000;
export const DEFAULT_MAX_UNPAGED_ROWS = 10_000;
const DEFAULT_MAX_FILTER_CONDITIONS = 200;
const DEFAULT_MAX_FILTER_DEPTH = 8;

/** Default name pattern for fields that must never be used as a query oracle or selected by callers. */
export const DEFAULT_SENSITIVE_FIELD_PATTERN =
  /(passw(or)?d|^pwd$|secret|credential|private_?key|api_?key|^salt$|_salt$|Salt$|token_?hash|(access|refresh|session|reset|verification|verify|auth|bearer|id)_?token$|^token$|hash$|digest|signature|cipher|encrypted|otp_?(code|secret)|(otp|verification|verify|recovery|backup|invite|reset)_?codes?$|mfa_?secret|totp|^jti$|nonce)/i;

/**
 * Model field metadata attached to an effective policy by DynamicQueryService / TreeService.
 * Not part of the public policy shape: callers cannot inject it through configuration.
 */
const MODEL_FIELDS = Symbol('zucker.crud.modelFields');

type PolicyWithFields = CrudQueryPolicy & { [MODEL_FIELDS]?: ReadonlyMap<string, ModelFieldInfo> };

/** Return a copy of `policy` that carries model field metadata for {@link assertQueryField}. */
export function withModelFields(
  policy: CrudQueryPolicy | undefined,
  fields: readonly ModelFieldInfo[] | ReadonlyMap<string, ModelFieldInfo> | undefined,
): CrudQueryPolicy {
  const base: PolicyWithFields = { ...(policy ?? {}) };
  if (fields) {
    base[MODEL_FIELDS] = fields instanceof Map
      ? fields as ReadonlyMap<string, ModelFieldInfo>
      : new Map((fields as readonly ModelFieldInfo[]).map((field) => [field.name, field]));
  }
  return base;
}

/** Field metadata carried by `policy`, if any. */
export function modelFieldsOf(policy: CrudQueryPolicy | undefined): ReadonlyMap<string, ModelFieldInfo> | undefined {
  return (policy as PolicyWithFields | undefined)?.[MODEL_FIELDS];
}

function isRelationKind(field: ModelFieldInfo): boolean {
  return field.kind === 'object' || field.kind === 'unsupported';
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_FIELDS = new Set(['AND', 'OR', 'NOT', '__proto__', 'constructor', 'prototype']);

export type QueryFieldUse = 'filter' | 'sort' | 'select';

/** Merge a module default policy with a service policy (service wins, deny lists are unioned). */
export function mergeQueryPolicy(
  base?: CrudQueryPolicy,
  override?: CrudQueryPolicy,
): CrudQueryPolicy {
  if (!base) return override ?? {};
  if (!override) return base;
  return {
    ...base,
    ...override,
    deniedFields: [...(base.deniedFields ?? []), ...(override.deniedFields ?? [])],
  };
}

export function resolveMaxPageSize(policy?: CrudQueryPolicy): number {
  const value = policy?.maxPageSize;
  return typeof value === 'number' && value >= 1 ? Math.floor(value) : DEFAULT_MAX_PAGE_SIZE;
}

export function resolveMaxUnpagedRows(policy?: CrudQueryPolicy): number {
  const value = policy?.maxUnpagedRows;
  if (value === Infinity) return Infinity;
  return typeof value === 'number' && value >= 1 ? Math.floor(value) : DEFAULT_MAX_UNPAGED_ROWS;
}

export function resolveMaxFilterConditions(policy?: CrudQueryPolicy): number {
  return policy?.maxFilterConditions ?? DEFAULT_MAX_FILTER_CONDITIONS;
}

export function resolveMaxFilterDepth(policy?: CrudQueryPolicy): number {
  return policy?.maxFilterDepth ?? DEFAULT_MAX_FILTER_DEPTH;
}

export function isSensitiveField(field: string, policy?: CrudQueryPolicy): boolean {
  if (policy?.deniedFields?.includes(field)) return true;
  const pattern = policy?.sensitiveFieldPattern;
  if (pattern === false) return false;
  return (pattern ?? DEFAULT_SENSITIVE_FIELD_PATTERN).test(field);
}

function allowListFor(use: QueryFieldUse, policy?: CrudQueryPolicy): readonly string[] | undefined {
  if (use === 'filter') return policy?.filterableFields;
  if (use === 'sort') return policy?.sortableFields;
  return policy?.selectableFields;
}

/** Throw 400 unless `field` is a plain, permitted scalar field name for the given use. */
export function assertQueryField(field: unknown, use: QueryFieldUse, policy?: CrudQueryPolicy): string {
  if (typeof field !== 'string' || !FIELD_NAME.test(field) || RESERVED_FIELDS.has(field)) {
    throw new BadRequestException(`Invalid ${use} field: ${String(field).slice(0, 64)}`);
  }
  const allowList = allowListFor(use, policy);
  // An explicit allow-list entry wins over the sensitive-name pattern, but never over deniedFields.
  if (policy?.deniedFields?.includes(field)) {
    throw new BadRequestException(`Field "${field}" cannot be used to ${use}`);
  }
  const fields = modelFieldsOf(policy);
  if (fields) {
    const info = fields.get(field);
    if (!info) throw new BadRequestException(`Unknown ${use} field: ${field}`);
    if (isRelationKind(info)) {
      // Relations need an explicit opt-in: selectableFields for includes, rawFilterFields for
      // filters. Sorting by a relation is never a scalar orderBy.
      const optedIn =
        (use === 'select' && !!policy?.selectableFields?.includes(field)) ||
        (use === 'filter' && !!policy?.rawFilterFields?.includes(field));
      if (!optedIn) throw new BadRequestException(`Field "${field}" cannot be used to ${use}`);
    }
  }
  if (allowList) {
    if (!allowList.includes(field)) throw new BadRequestException(`Field "${field}" cannot be used to ${use}`);
    return field;
  }
  if (isSensitiveField(field, policy)) {
    throw new BadRequestException(`Field "${field}" cannot be used to ${use}`);
  }
  return field;
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value instanceof Date
  );
}

/** Throw 400 unless the filter value is a primitive / Date or a (bounded) array of those. */
export function assertFilterValue(field: string, value: unknown): void {
  if (isPrimitive(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new BadRequestException(`Filter "${field}" has too many values`);
    if (value.every(isPrimitive)) return;
  }
  throw new BadRequestException(`Filter "${field}" only accepts scalar values`);
}

export function isRawFilterField(field: string, policy?: CrudQueryPolicy): boolean {
  return !!policy?.rawFilterFields?.includes(field);
}

/** Values a scalar / enum column can hold in a result row. */
function isScalarResultValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (value instanceof Date) return true;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (value instanceof Uint8Array) return true;
  // Prisma / decimal.js Decimal
  const candidate = value as { toFixed?: unknown; d?: unknown; s?: unknown; e?: unknown };
  if (typeof candidate.toFixed === 'function' && 'd' in candidate && 's' in candidate && 'e' in candidate) return true;
  if (Array.isArray(value)) return value.every((item) => item === null || typeof item !== 'object' || item instanceof Date);
  return false;
}

/**
 * Without field metadata, remove included keys whose values look like relation rows (or JSON
 * objects) unless the field is explicitly in `selectableFields`. Returns a new array; rows that
 * lose a field are shallow copies (adapters may return live objects, e.g. InMemoryAdapter), others
 * are returned as is. Reports the stripped field names through `onStrip`.
 */
export function stripRelationLikeIncludes<T>(
  rows: T[],
  includes: readonly string[] | undefined,
  policy: CrudQueryPolicy | undefined,
  onStrip?: (fields: string[]) => void,
): T[] {
  if (!includes?.length || policy?.selectableFields || modelFieldsOf(policy)) return rows;
  const stripped = new Set<string>();
  const result = rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const record = row as Record<string, unknown>;
    let copy: Record<string, unknown> | undefined;
    for (const field of includes) {
      if (Object.prototype.hasOwnProperty.call(record, field) && !isScalarResultValue(record[field])) {
        copy ??= { ...record };
        delete copy[field];
        stripped.add(field);
      }
    }
    return (copy ?? row) as T;
  });
  if (stripped.size > 0) onStrip?.([...stripped]);
  return result;
}
