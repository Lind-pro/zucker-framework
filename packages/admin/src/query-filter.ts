import { BadRequestException } from '@nestjs/common';

/** Both lists are allow-lists: a field that is not named cannot be filtered on at all. */
export interface AdminQueryFilterOptions {
  /** Fields that accept exact matching (`field` or `field$eq`) with a string, number or boolean. */
  eq: readonly string[];
  /** Text fields that accept `field$like` (case-insensitive substring match). */
  like: readonly string[];
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** ORM combinators are never field names, even if a consumer lists them by mistake. */
const RESERVED = new Set(['AND', 'OR', 'NOT', 'is', 'isNot', 'some', 'every', 'none']);
const MAX_LIKE_LENGTH = 200;

function unsupported(key: string): never {
  throw new BadRequestException(`Unsupported filter: ${key.slice(0, 80)}`);
}

/**
 * Translate the admin list `filter` map into a database `where`.
 *
 * - `field: scalar` or `field$eq: scalar` is accepted only for `eq` fields.
 * - `field$like: string` is accepted only for `like` fields.
 * - Every other key (unlisted columns such as credential hashes or login metadata, relation names,
 *   ORM combinators like `AND`/`OR`/`NOT`, object/array values, other `$` operators) is rejected
 *   with 400, so nothing a caller sends reaches the database unvetted.
 * Empty values are ignored, matching search forms that send blank inputs.
 */
export function toAdminWhere(filter: unknown, options: AdminQueryFilterOptions): Record<string, unknown> {
  if (filter === undefined || filter === null) return {};
  if (typeof filter !== 'object' || Array.isArray(filter)) throw new BadRequestException('filter must be an object');
  const eq = new Set(options.eq.filter((field) => !RESERVED.has(field)));
  const like = new Set(options.like.filter((field) => !RESERVED.has(field)));
  const where: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    const [field, operator, ...rest] = key.split('$');
    if (!field || !FIELD.test(field) || rest.length || RESERVED.has(field)) unsupported(key);
    if (operator === undefined || operator === 'eq') {
      if (!eq.has(field)) unsupported(key);
      if (!['string', 'number', 'boolean'].includes(typeof value))
        throw new BadRequestException(`Filter ${field} must be a scalar value`);
      where[field] = value;
      continue;
    }
    if (operator !== 'like' || !like.has(field)) unsupported(key);
    if (typeof value !== 'string' || value.length > MAX_LIKE_LENGTH)
      throw new BadRequestException(`Filter ${field}$like must be text of at most ${MAX_LIKE_LENGTH} characters`);
    where[field] = { contains: value, mode: 'insensitive' };
  }
  return where;
}

/** Validated zero-based page bounds for the `_query` list endpoints. */
export function adminPage(body: { pageIndex?: unknown; pageSize?: unknown }, maxPageSize = 1000): { pageIndex: number; pageSize: number } {
  const pageIndex = body.pageIndex ?? 0;
  const pageSize = body.pageSize ?? 10;
  if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 1_000_000)
    throw new BadRequestException('pageIndex must be a non-negative integer');
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize)
    throw new BadRequestException(`pageSize must be an integer from 1 to ${maxPageSize}`);
  return { pageIndex, pageSize };
}
