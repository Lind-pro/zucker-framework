import type { SiteDocument } from '@zucker-framework/fe-site/content';

/** `log` entries are changelog notes; like posts they use a single slug segment and carry no categories. */
export type ContentKind = 'page' | 'post' | 'doc' | 'log';
export const CONTENT_KINDS: readonly ContentKind[] = ['page', 'post', 'doc', 'log'];
export const CONTENT_LOCALES: readonly ContentLocale[] = ['zh', 'en'];
export type ContentLocale = 'zh' | 'en';
export type ContentStatus = 'draft' | 'published' | 'archived';
export interface EntryDraft { document: SiteDocument; categoryIds: string[] }
export interface CategoryDraft { title: string; description: string }
export interface EntryRow {
  id: string; kind: ContentKind; locale: ContentLocale; slug: string; draft: EntryDraft; status: ContentStatus;
  publishedSlug: string | null; published: EntryDraft | null; publishedTitle: string | null; publishedDescription: string | null;
  searchText: string; publishedAt: Date | null; publishedRevision: number | null; revision: number;
  createdBy: string; updatedBy: string; createdAt: Date; updatedAt: Date;
}
export interface CategoryRow {
  id: string; locale: ContentLocale; slug: string; draft: CategoryDraft; status: ContentStatus;
  publishedSlug: string | null; published: CategoryDraft | null; publishedAt: Date | null;
  publishedRevision: number | null; revision: number; createdBy: string; updatedBy: string; createdAt: Date; updatedAt: Date;
}
export interface PublicCategory { id: string; locale: ContentLocale; slug: string; title: string; description: string }
export interface PublicEntry {
  id: string; kind: ContentKind; locale: ContentLocale; slug: string; title: string; description: string;
  authorName: string; publishedAt: Date; updatedAt: Date; categories: PublicCategory[];
  /** `database` for CMS rows, `file` for documents shipped in the app's `content/` directory. */
  source: 'database' | 'file';
}
export interface PublicEntryDetail extends PublicEntry { document: SiteDocument }
