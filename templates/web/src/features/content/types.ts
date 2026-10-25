import type { SiteColorMode, SiteDocument } from '@zucker-framework/fe-site/content';

export type ContentKind = 'page' | 'post' | 'doc';
export type ContentLocale = 'zh' | 'en';
export interface SiteLink {
  label: string;
  href: string;
}
export interface PublicSiteSettings {
  name: string;
  description: string;
  theme: string;
  appearance: SiteColorMode;
  navigation: SiteLink[];
  footerLinks: SiteLink[];
  siteUrl: string;
}
export interface SiteSettings {
  name: string;
  theme: string;
  appearance: SiteColorMode;
  description: Record<ContentLocale, string>;
  navigation: Record<ContentLocale, SiteLink[]>;
  footerLinks: Record<ContentLocale, SiteLink[]>;
}
export interface Category {
  id: string;
  locale: ContentLocale;
  slug: string;
  title: string;
  description: string;
}
export interface Entry {
  id: string;
  kind: ContentKind;
  locale: ContentLocale;
  slug: string;
  title: string;
  description: string;
  authorName: string;
  publishedAt: string;
  updatedAt: string;
  categories: Category[];
}
export interface EntryDetail extends Entry {
  document: SiteDocument;
}
export interface EntryPage {
  data: Entry[];
  total: number;
  page: number;
  pageSize: number;
  category: Category | null;
}
export interface DraftEntry {
  id: string;
  kind: ContentKind;
  locale: ContentLocale;
  slug: string;
  draft: { document: SiteDocument; categoryIds: string[] };
  status: 'draft' | 'published' | 'archived';
  revision: number;
  publishedRevision: number | null;
  publishedSlug: string | null;
  updatedAt: string;
}
export interface DraftCategory {
  id: string;
  locale: ContentLocale;
  slug: string;
  draft: { title: string; description: string };
  status: 'draft' | 'published' | 'archived';
  revision: number;
  publishedRevision: number | null;
}
export function contentPath(kind: ContentKind, slug: string): string {
  return `${kind === 'post' ? '/blog' : kind === 'doc' ? '/docs' : ''}/${slug}`;
}
/** Public site links use document navigation, including links into protected areas. */
export function localizedHref(href: string, locale: string): string {
  return href.startsWith('/') && !/^\/(?:en|zh)(?:\/|$)/.test(href)
    ? `/${locale}${href === '/' ? '' : href}`
    : href;
}
export function emptyDocument(): SiteDocument {
  return {
    version: 1,
    title: '',
    description: '',
    authorName: '',
    markdown: '',
    blocks: [],
    seo: { title: '', description: '', noIndex: false },
  };
}
