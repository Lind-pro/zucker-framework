import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { hasVisibleSiteContent, siteDocumentText, validateSiteDocument, visibleSiteDocument } from '@zucker-framework/fe-site/content';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { assertRevision, ContentRepository, isUniqueConflict } from './content.repository';
import type { CategoryRow, ContentLocale, EntryDraft, EntryRow, PublicCategory, PublicEntry } from './content.types';
import * as input from './content.validation';

@Injectable()
export class ContentService {
  private readonly repository: ContentRepository;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase) { this.repository = new ContentRepository(database); }

  createEntry(actor: string, body: unknown) {
    const value = input.record(body, ['kind', 'locale', 'slug', 'document', 'categoryIds']);
    const kind = input.kind(value.kind);
    return this.repository.createEntry({ kind, locale: input.locale(value.locale), slug: input.slug(value.slug, kind),
      draft: input.entryDraft(value.document, value.categoryIds, kind) }, actor);
  }
  createCategory(actor: string, body: unknown) {
    const value = input.record(body, ['locale', 'slug', 'title', 'description']);
    return this.repository.createCategory({ locale: input.locale(value.locale), slug: input.slug(value.slug, 'category'),
      draft: input.categoryDraft(value.title, value.description) }, actor);
  }
  adminEntries(query: Record<string, unknown>) {
    input.record(query, ['kind', 'locale', 'status', 'page', 'pageSize']);
    return this.repository.adminEntries({ page: input.page(query.page), pageSize: input.pageSize(query.pageSize),
      ...(query.kind === undefined ? {} : { kind: input.kind(query.kind) }),
      ...(query.locale === undefined ? {} : { locale: input.locale(query.locale) }),
      ...(query.status === undefined ? {} : { status: input.status(query.status) }) });
  }
  adminEntry(id: string) { return this.database.transaction(tx => this.repository.entry(tx, input.identifier(id))); }
  adminCategories(language?: string) { return this.repository.adminCategories(language === undefined ? undefined : input.locale(language)); }
  adminCategory(id: string) { return this.database.transaction(tx => this.repository.category(tx, input.identifier(id))); }

  async updateEntry(actor: string, id: string, body: unknown) {
    input.identifier(id);
    const value = input.record(body, ['expectedRevision', 'slug', 'document', 'categoryIds']);
    const expected = input.revision(value.expectedRevision);
    return this.conflicts(() => this.database.transaction(async tx => {
      const row = await this.repository.entry(tx, id, true); assertRevision(row, expected);
      if (row.status === 'archived') throw new ConflictException('Restore archived content before editing');
      const draft = input.entryDraft(value.document, value.categoryIds, row.kind), slug = input.slug(value.slug, row.kind);
      const result = await tx.query<EntryRow>(`UPDATE site_content_entries SET "slug"=$3,"draft"=$4::jsonb,
        "revision"="revision"+1,"updatedBy"=$5,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "revision"=$2 RETURNING *`,
      [id, expected, slug, JSON.stringify(draft), actor]);
      return this.changed(result.rows[0]);
    }));
  }
  async updateCategory(actor: string, id: string, body: unknown) {
    input.identifier(id);
    const value = input.record(body, ['expectedRevision', 'slug', 'title', 'description']);
    const expected = input.revision(value.expectedRevision);
    return this.conflicts(() => this.database.transaction(async tx => {
      const row = await this.repository.category(tx, id, true); assertRevision(row, expected);
      if (row.status === 'archived') throw new ConflictException('Restore archived categories before editing');
      const draft = input.categoryDraft(value.title, value.description), slug = input.slug(value.slug, 'category');
      const result = await tx.query<CategoryRow>(`UPDATE site_content_categories SET "slug"=$3,"draft"=$4::jsonb,
        "revision"="revision"+1,"updatedBy"=$5,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "revision"=$2 RETURNING *`,
      [id, expected, slug, JSON.stringify(draft), actor]);
      return this.changed(result.rows[0]);
    }));
  }

  async transitionEntry(actor: string, id: string, action: string, body: unknown) {
    input.identifier(id); this.action(action);
    const expected = input.revision(input.record(body, ['expectedRevision']).expectedRevision);
    return this.conflicts(() => this.database.transaction(async tx => {
      const row = await this.repository.entry(tx, id, true); assertRevision(row, expected); this.transitionAllowed(row.status, action);
      if (action === 'publish') {
        const draft = input.entryDraft(row.draft.document, row.draft.categoryIds, row.kind);
        if (!hasVisibleSiteContent(draft.document)) throw new BadRequestException('Add visible content before publishing');
        await this.assertCategories(tx, draft.categoryIds, row.locale);
        const published: EntryDraft = { ...draft, document: visibleSiteDocument(draft.document) };
        const result = await tx.query<EntryRow>(`UPDATE site_content_entries SET "status"='published',"publishedSlug"="slug",
          "published"=$3::jsonb,"publishedTitle"=$4,"publishedDescription"=$5,"searchText"=$6,
          "publishedAt"=CURRENT_TIMESTAMP,"publishedRevision"="revision"+1,"revision"="revision"+1,
          "updatedBy"=$7,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "revision"=$2 RETURNING *`,
        [id, expected, JSON.stringify(published), published.document.title, published.document.description, siteDocumentText(published.document), actor]);
        return this.changed(result.rows[0]);
      }
      const next = action === 'archive' ? 'archived' : 'draft';
      const result = await tx.query<EntryRow>(`UPDATE site_content_entries SET "status"=$3,"publishedSlug"=NULL,"published"=NULL,
        "publishedTitle"=NULL,"publishedDescription"=NULL,"searchText"='',"publishedAt"=NULL,"publishedRevision"=NULL,
        "revision"="revision"+1,"updatedBy"=$4,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "revision"=$2 RETURNING *`,
      [id, expected, next, actor]);
      return this.changed(result.rows[0]);
    }));
  }
  async transitionCategory(actor: string, id: string, action: string, body: unknown) {
    input.identifier(id); this.action(action);
    const expected = input.revision(input.record(body, ['expectedRevision']).expectedRevision);
    return this.conflicts(() => this.database.transaction(async tx => {
      const row = await this.repository.category(tx, id, true); assertRevision(row, expected); this.transitionAllowed(row.status, action);
      if (action === 'publish') {
        const published = input.categoryDraft(row.draft.title, row.draft.description);
        const result = await tx.query<CategoryRow>(`UPDATE site_content_categories SET "status"='published',"publishedSlug"="slug",
          "published"=$3::jsonb,"publishedAt"=CURRENT_TIMESTAMP,"publishedRevision"="revision"+1,
          "revision"="revision"+1,"updatedBy"=$4,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "revision"=$2 RETURNING *`,
        [id, expected, JSON.stringify(published), actor]);
        return this.changed(result.rows[0]);
      }
      const result = await tx.query<CategoryRow>(`UPDATE site_content_categories SET "status"=$3,"publishedSlug"=NULL,"published"=NULL,
        "publishedAt"=NULL,"publishedRevision"=NULL,"revision"="revision"+1,"updatedBy"=$4,"updatedAt"=CURRENT_TIMESTAMP
        WHERE "id"=$1 AND "revision"=$2 RETURNING *`, [id, expected, action === 'archive' ? 'archived' : 'draft', actor]);
      return this.changed(result.rows[0]);
    }));
  }

  async publicEntries(query: Record<string, unknown>) {
    input.record(query, ['kind', 'locale', 'page', 'category']);
    const kind = input.kind(query.kind), locale = input.locale(query.locale), page = input.page(query.page);
    if (query.category !== undefined && kind !== 'post') throw new BadRequestException('Categories apply to blog posts');
    return this.database.transaction(async tx => {
      let category: PublicCategory | null = null;
      if (query.category !== undefined) {
        const slug = input.slug(query.category, 'category');
        const found = await tx.query<CategoryRow>('SELECT * FROM site_content_categories WHERE "locale"=$1 AND "publishedSlug"=$2 AND "status"=\'published\'', [locale, slug]);
        if (!found.rows[0]) throw new NotFoundException('Published category was not found');
        category = this.categorySummary(found.rows[0]);
      }
      const values = [kind, locale, category ? JSON.stringify([category.id]) : null];
      const where = '"kind"=$1 AND "locale"=$2 AND "status"=\'published\' AND ($3::jsonb IS NULL OR ("published"->\'categoryIds\') @> $3::jsonb)';
      const count = await tx.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM site_content_entries WHERE ${where}`, values);
      const rows = await tx.query<EntryRow>(`SELECT * FROM site_content_entries WHERE ${where} ORDER BY "publishedAt" DESC,"id" LIMIT 20 OFFSET $4`, [...values, (page - 1) * 20]);
      const categories = await this.categories(tx, locale);
      return { data: rows.rows.map(row => this.entrySummary(row, categories)), total: count.rows[0]?.total ?? 0, page, pageSize: 20, category };
    });
  }
  async publicEntry(query: Record<string, unknown>) {
    input.record(query, ['kind', 'locale', 'slug']);
    const kind = input.kind(query.kind), locale = input.locale(query.locale), slug = input.slug(query.slug, kind);
    return this.database.transaction(async tx => {
      const result = await tx.query<EntryRow>('SELECT * FROM site_content_entries WHERE "kind"=$1 AND "locale"=$2 AND "publishedSlug"=$3 AND "status"=\'published\'', [kind, locale, slug]);
      const row = result.rows[0]; if (!row) throw new NotFoundException('Published content was not found');
      const summary = this.entrySummary(row, await this.categories(tx, locale));
      return { ...summary, document: visibleSiteDocument(validateSiteDocument(row.published?.document)) };
    });
  }
  publicCategories(language: unknown) {
    const locale = input.locale(language);
    return this.database.transaction(tx => this.categories(tx, locale));
  }
  async publicSearch(query: Record<string, unknown>) {
    input.record(query, ['locale', 'q']);
    const locale = input.locale(query.locale), q = input.boundedText(query.q, 100, true);
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.database.transaction(async tx => {
      const rows = await tx.query<EntryRow>(`SELECT * FROM site_content_entries WHERE "kind"='doc' AND "locale"=$1 AND "status"='published'
        AND (to_tsvector('simple',"searchText") @@ websearch_to_tsquery('simple',$2) OR "searchText" ILIKE $3)
        ORDER BY CASE WHEN lower("publishedTitle")=lower($2) THEN 0 WHEN "publishedTitle" ILIKE $3 THEN 1 ELSE 2 END,
          "publishedAt" DESC,"id" LIMIT 20`, [locale, q, pattern]);
      return { data: rows.rows.map(row => ({ ...this.entrySummary(row, []), excerpt: this.excerpt(row.searchText, q) })), query: q, limit: 20 };
    });
  }
  async sitemap(pageValue: unknown) {
    const page = input.page(pageValue);
    return this.database.transaction(async tx => {
      const source = `SELECT "id",'entry' AS resource,"kind","locale","publishedSlug" AS slug,"publishedAt" AS "updatedAt"
        FROM site_content_entries WHERE "status"='published' AND COALESCE("published"->'document'->'seo'->>'noIndex','false') <> 'true'
        UNION ALL SELECT "id",'category' AS resource,'post' AS kind,"locale","publishedSlug" AS slug,"publishedAt" AS "updatedAt"
        FROM site_content_categories WHERE "status"='published'`;
      const count = await tx.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM (${source}) AS documents`);
      const rows = await tx.query(`SELECT * FROM (${source}) AS documents ORDER BY resource,kind,locale,slug,"id" LIMIT 1000 OFFSET $1`, [(page - 1) * 1000]);
      return { data: rows.rows, total: count.rows[0]?.total ?? 0, page, pageSize: 1000 };
    });
  }

  private async categories(tx: ApplicationTransaction, locale: ContentLocale): Promise<PublicCategory[]> {
    const rows = await tx.query<CategoryRow>('SELECT * FROM site_content_categories WHERE "locale"=$1 AND "status"=\'published\' ORDER BY "published"->>\'title\',"id"', [locale]);
    return rows.rows.map(row => this.categorySummary(row));
  }
  private categorySummary(row: CategoryRow): PublicCategory {
    if (!row.published || !row.publishedSlug) throw new Error('Invalid published category');
    return { id: row.id, locale: row.locale, slug: row.publishedSlug, title: row.published.title, description: row.published.description };
  }
  private entrySummary(row: EntryRow, categories: PublicCategory[]): PublicEntry {
    if (!row.published || !row.publishedSlug || !row.publishedAt) throw new Error('Invalid published entry');
    const document = validateSiteDocument(row.published.document);
    return { id: row.id, kind: row.kind, locale: row.locale, slug: row.publishedSlug, title: document.title, description: document.description,
      authorName: document.authorName, publishedAt: row.publishedAt, updatedAt: row.publishedAt,
      categories: categories.filter(category => row.published?.categoryIds.includes(category.id)) };
  }
  private async assertCategories(tx: ApplicationTransaction, ids: string[], locale: ContentLocale): Promise<void> {
    if (!ids.length) return;
    const found = await tx.query<{ id: string }>('SELECT "id" FROM site_content_categories WHERE "id"=ANY($1::text[]) AND "locale"=$2 AND "status"=\'published\' FOR SHARE', [ids, locale]);
    if (found.rows.length !== ids.length) throw new BadRequestException('Publish the selected categories in the same language first');
  }
  private action(value: string): void {
    if (!['publish', 'unpublish', 'archive', 'restore'].includes(value)) throw new BadRequestException('Invalid publication action');
  }
  private transitionAllowed(status: string, action: string): void {
    if (status === 'archived' && action !== 'restore' && action !== 'archive') throw new ConflictException('Restore archived content first');
    if (action === 'restore' && status !== 'archived') throw new ConflictException('Only archived content can be restored');
  }
  private changed<T>(row: T | undefined): T {
    if (!row) throw new ConflictException('Content changed; reload before saving');
    return row;
  }
  private async conflicts<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { if (isUniqueConflict(error)) throw new ConflictException('This content address is already in use'); throw error; }
  }
  private excerpt(text: string, query: string): string {
    const start = Math.max(0, text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 60);
    return `${start ? '…' : ''}${text.slice(start, start + 220).replace(/\s+/g, ' ').trim()}${text.length > start + 220 ? '…' : ''}`;
  }
}
