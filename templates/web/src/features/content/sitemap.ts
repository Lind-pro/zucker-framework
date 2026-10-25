import { publicContent, readSiteSettings } from './server';
import { contentPath, type ContentKind } from './types';
export interface SitemapRow {
  resource: 'entry' | 'category';
  kind: ContentKind;
  locale: string;
  slug: string;
  updatedAt: string;
}
export interface SitemapPage {
  data: SitemapRow[];
  total: number;
  page: number;
  pageSize: number;
}
export const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  );
export async function sitemapPage(page: number) {
  return publicContent<SitemapPage>('sitemap', { page: String(page) });
}
export async function sitemapOrigin() {
  return (await readSiteSettings('en')).siteUrl;
}
export function sitemapUrl(row: SitemapRow, origin: string) {
  return new URL(
    `/${row.locale}${row.resource === 'category' ? `/blog/category/${row.slug}` : contentPath(row.kind, row.slug)}`,
    origin,
  ).href;
}
export function xmlResponse(body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
