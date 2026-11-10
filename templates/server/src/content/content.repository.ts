import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import type { CategoryDraft, CategoryRow, ContentKind, ContentLocale, ContentStatus, EntryDraft, EntryRow } from './content.types';

export function assertRevision(row: { revision: number }, expected: number): void {
  if (row.revision !== expected) throw new ConflictException('Content changed; reload before saving');
}
export function isUniqueConflict(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<object>();
  while (pending.length && seen.size < 16) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; originalCode?: unknown; meta?: unknown; cause?: unknown; driverAdapterError?: unknown };
    if (value.code === 'P2002' || value.code === '23505' || value.originalCode === '23505') return true;
    // Prisma 7 raw SQL wraps PostgreSQL errors as P2010 -> meta.driverAdapterError.cause.originalCode.
    pending.push(value.meta, value.cause, value.driverAdapterError);
  }
  return false;
}

/** Consumer-owned SQL over the existing transaction port. No in-memory CMS or implicit file fallback. */
export class ContentRepository {
  constructor(readonly database: ApplicationDatabase) {}

  async createEntry(input: { kind: ContentKind; locale: ContentLocale; slug: string; draft: EntryDraft }, actor: string) {
    return this.database.transaction(async tx => {
      const result = await tx.query<EntryRow>(`INSERT INTO site_content_entries
        ("id","kind","locale","slug","draft","createdBy","updatedBy") VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)
        ON CONFLICT ("kind","locale","slug") DO NOTHING RETURNING *`,
      [randomUUID(), input.kind, input.locale, input.slug, JSON.stringify(input.draft), actor]);
      if (!result.rows[0]) throw new ConflictException('This content slug already exists');
      return result.rows[0];
    });
  }
  async createCategory(input: { locale: ContentLocale; slug: string; draft: CategoryDraft }, actor: string) {
    return this.database.transaction(async tx => {
      const result = await tx.query<CategoryRow>(`INSERT INTO site_content_categories
        ("id","locale","slug","draft","createdBy","updatedBy") VALUES ($1,$2,$3,$4::jsonb,$5,$5)
        ON CONFLICT ("locale","slug") DO NOTHING RETURNING *`,
      [randomUUID(), input.locale, input.slug, JSON.stringify(input.draft), actor]);
      if (!result.rows[0]) throw new ConflictException('This category slug already exists');
      return result.rows[0];
    });
  }
  async entry(tx: ApplicationTransaction, id: string, lock = false): Promise<EntryRow> {
    const found = await tx.query<EntryRow>(`SELECT * FROM site_content_entries WHERE "id"=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!found.rows[0]) throw new NotFoundException('Content was not found');
    return found.rows[0];
  }
  async category(tx: ApplicationTransaction, id: string, lock = false): Promise<CategoryRow> {
    const found = await tx.query<CategoryRow>(`SELECT * FROM site_content_categories WHERE "id"=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!found.rows[0]) throw new NotFoundException('Category was not found');
    return found.rows[0];
  }
  async adminEntries(filter: { kind?: ContentKind; locale?: ContentLocale; status?: ContentStatus; page: number; pageSize?: number }) {
    const pageSize = filter.pageSize ?? 20;
    return this.database.transaction(async tx => {
      const values = [filter.kind ?? null, filter.locale ?? null, filter.status ?? null];
      const where = '($1::text IS NULL OR "kind"=$1) AND ($2::text IS NULL OR "locale"=$2) AND ($3::text IS NULL OR "status"=$3)';
      const count = await tx.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM site_content_entries WHERE ${where}`, values);
      const data = await tx.query<EntryRow>(`SELECT * FROM site_content_entries WHERE ${where} ORDER BY "updatedAt" DESC,"id" LIMIT $5 OFFSET $4`, [...values, (filter.page - 1) * pageSize, pageSize]);
      return { data: data.rows, total: count.rows[0]?.total ?? 0, page: filter.page, pageSize };
    });
  }
  async adminCategories(language?: ContentLocale) {
    return this.database.transaction(async tx => (await tx.query<CategoryRow>(
      'SELECT * FROM site_content_categories WHERE ($1::text IS NULL OR "locale"=$1) ORDER BY "updatedAt" DESC,"id"', [language ?? null])).rows);
  }
}
