import { BadRequestException } from '@nestjs/common';
import { assertQueryField, assertFilterValue, type CrudQueryPolicy } from './query/query-policy';
import { normalizeOperatorType } from './operators';

/**
 * Fields the server owns. Generated write routes drop them from request bodies so callers cannot
 * forge audit data or resurrect soft-deleted rows; listeners / DB defaults fill them instead.
 */
export const DEFAULT_SERVER_CONTROLLED_FIELDS: readonly string[] = [
  'creatorId',
  'creatorName',
  'createdAt',
  'createTime',
  'modifierId',
  'modifierName',
  'updatedAt',
  'updateTime',
  'deletedAt',
];

/** Prisma nested-write operation keys. */
const NESTED_WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'connect',
  'connectOrCreate',
  'disconnect',
  'set',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Write-body policy for the generated create / update / save / batch routes. */
export interface CrudWritePolicy {
  /** Allow-list of body fields. When set, every other field is rejected with 400. */
  writableFields?: readonly string[];
  /**
   * Fields removed from bodies before they reach the service.
   * Default {@link DEFAULT_SERVER_CONTROLLED_FIELDS}; pass `[]` to keep the legacy pass-through.
   */
  serverControlledFields?: readonly string[];
  /**
   * Accept Prisma nested writes (`{ relation: { connect | create | update | delete... } }`).
   * Default false: such values are rejected with 400 because they run relation writes with the
   * service's privileges.
   */
  allowNestedWrites?: boolean;
  /** Keep a client supplied `id` on create (default true, ids are commonly client-generated). */
  allowClientId?: boolean;
  /**
   * Fields callers may never write (400), e.g. `tenantId`, `ownerId`, `role`, `status`. Use it
   * when an allow-list (`writableFields` or a whitelisting DTO) is impractical. Without either,
   * every scalar column except the server-controlled ones is writable by the caller.
   */
  deniedFields?: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Built-ins that are objects but never a write body. */
function isBuiltinObject(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof RegExp ||
    value instanceof Promise ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  );
}

/**
 * A request body: a plain object, or a DTO class instance produced by
 * `ValidationPipe({ transform: true })` (copied to a plain object of its own enumerable
 * properties). Arrays, Dates, Maps, Buffers and other built-ins are rejected.
 */
function toBodyRecord(value: unknown): Record<string, unknown> | undefined {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isBuiltinObject(value)) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) copy[key] = (value as Record<string, unknown>)[key];
  return copy;
}

/**
 * A plain object whose keys include a Prisma relation-write operation with an object/array
 * argument (or a bare to-one `delete`/`disconnect: true`). JSON column values such as
 * `{ create: true, read: false }` (permission flags) are not treated as nested writes.
 */
export function looksLikeNestedWrite(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  const opKeys = keys.filter((key) => NESTED_WRITE_OPERATIONS.has(key));
  if (opKeys.length === 0) return false;
  if (opKeys.some((key) => typeof value[key] === 'object' && value[key] !== null)) return true;
  // `{ delete: true }` / `{ disconnect: true }` on a to-one relation.
  return keys.every((key) => (key === 'delete' || key === 'disconnect') && value[key] === true);
}

/**
 * Validate and filter one write body from an HTTP caller.
 * @param mode `create` keeps a client `id` (unless disabled); `update` always drops `id`.
 */
export function sanitizeWriteBody<T>(
  body: unknown,
  policy: CrudWritePolicy = {},
  mode: 'create' | 'update' = 'create',
): Partial<T> {
  const record = toBodyRecord(body);
  if (!record) throw new BadRequestException('Request body must be an object');
  const serverControlled = new Set(policy.serverControlledFields ?? DEFAULT_SERVER_CONTROLLED_FIELDS);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (FORBIDDEN_KEYS.has(key)) throw new BadRequestException(`Field "${key}" is not allowed`);
    if (serverControlled.has(key)) continue;
    if (policy.deniedFields?.includes(key)) throw new BadRequestException(`Field "${key}" is not writable`);
    if (key === 'id' && (mode === 'update' || policy.allowClientId === false)) continue;
    if (policy.writableFields && key !== 'id' && !policy.writableFields.includes(key)) {
      throw new BadRequestException(`Field "${key}" is not writable`);
    }
    if (!policy.allowNestedWrites && looksLikeNestedWrite(value)) {
      throw new BadRequestException(`Field "${key}" cannot contain relation writes`);
    }
    result[key] = value;
  }
  return result as Partial<T>;
}

/** Sanitize a body array (createMany / save). */
export function sanitizeWriteBodies<T>(
  bodies: unknown,
  policy: CrudWritePolicy = {},
  mode: 'create' | 'update' = 'create',
  maxItems = 1000,
): Partial<T>[] {
  if (!Array.isArray(bodies)) throw new BadRequestException('Request body must be an array');
  if (bodies.length > maxItems) throw new BadRequestException(`At most ${maxItems} items per request`);
  return bodies.map((body) => sanitizeWriteBody<T>(body, policy, mode));
}

/** Prisma scalar filter operators accepted inside a batch `where`. */
const BATCH_SCALAR_OPERATORS = new Set([
  'equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode',
]);

/**
 * Validate a caller-supplied `where` for updateMany / deleteMany.
 *
 * Accepted shape: `{ field: scalar | { equals | in | notIn | not | lt | lte | gt | gte | contains |
 * startsWith | endsWith: scalar-or-scalar-array } }` with at least one constraining field.
 * Rejected: empty where, `AND`/`OR`/`NOT` trees, relation filters, sensitive fields (same field rules
 * as dynamic query filters), and a "match all" `not` on its own (e.g. `{ id: { not: '' } }`).
 * Filter-map syntax (`{ "status$eq": 1 }`) is NOT accepted here; use Prisma scalar syntax.
 */
export function assertSafeBatchWhere(where: unknown, policy?: CrudQueryPolicy): Record<string, unknown> {
  if (!isPlainObject(where) || Object.keys(where).length === 0) {
    throw new BadRequestException('deleteMany/updateMany 不允许空 where 条件');
  }
  let narrowing = 0;
  for (const [field, condition] of Object.entries(where)) {
    if (field.includes('$')) {
      throw new BadRequestException(`Batch where uses Prisma scalar syntax, not "${field}"`);
    }
    assertQueryField(field, 'filter', policy);
    if (!isPlainObject(condition)) {
      assertFilterValue(field, condition);
      if (Array.isArray(condition)) throw new BadRequestException(`Use { in: [...] } for "${field}"`);
      narrowing++;
      continue;
    }
    const ops = Object.keys(condition);
    if (ops.length === 0) throw new BadRequestException(`Empty condition for "${field}"`);
    for (const op of ops) {
      if (!BATCH_SCALAR_OPERATORS.has(op)) {
        throw new BadRequestException(`Unsupported batch operator "${normalizeOperatorType(op).slice(0, 32)}"`);
      }
      const value = condition[op];
      if (op === 'mode') {
        if (value !== 'insensitive' && value !== 'default') throw new BadRequestException('Invalid mode');
        continue;
      }
      assertFilterValue(field, value);
      if ((op === 'contains' || op === 'startsWith' || op === 'endsWith') && (typeof value !== 'string' || value.length === 0)) {
        // An empty pattern matches every row.
        throw new BadRequestException(`"${op}" for "${field}" needs a non-empty string`);
      }
      if ((op === 'in' || op === 'notIn') && !Array.isArray(value)) {
        throw new BadRequestException(`"${op}" for "${field}" needs an array`);
      }
      if (op === 'in' && Array.isArray(value) && value.length === 0) {
        throw new BadRequestException(`"in" for "${field}" needs at least one value`);
      }
      if (op !== 'not' && op !== 'notIn') narrowing++;
    }
  }
  if (narrowing === 0) {
    throw new BadRequestException('Batch where must include a positive (equals / in / range / match) condition');
  }
  return where;
}
