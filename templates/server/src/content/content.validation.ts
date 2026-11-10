import { BadRequestException } from '@nestjs/common';
import { SiteContentValidationError, validateSiteDocument } from '@zucker-framework/fe-site/content';
import type { CategoryDraft, ContentKind, ContentLocale, ContentStatus, EntryDraft } from './content.types';

export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw new BadRequestException('Unexpected content fields');
  return value as Record<string, unknown>;
}
export function kind(value: unknown): ContentKind {
  if (value !== 'page' && value !== 'post' && value !== 'doc' && value !== 'log') throw new BadRequestException('Invalid content kind');
  return value;
}
export function locale(value: unknown): ContentLocale {
  if (value !== 'zh' && value !== 'en') throw new BadRequestException('Unsupported content language');
  return value;
}
export function status(value: unknown): ContentStatus {
  if (value !== 'draft' && value !== 'published' && value !== 'archived') throw new BadRequestException('Invalid content status');
  return value;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw new BadRequestException('Invalid content identifier');
  return value;
}
const reservedPageRoots = new Set(['api', 'account', 'billing', 'pricing', 'blog', 'docs', 'content', 'dashboard',
  'changelog', 'login', 'register', 'verify-email', 'forgot-password', 'reset-password', 'oauth', 'en', 'zh', 'sitemaps']);
export function slug(value: unknown, type: ContentKind | 'category'): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > (type === 'category' ? 100 : 200)
    || !/^[a-z0-9]+([/-][a-z0-9]+)*$/.test(value)) throw new BadRequestException('Invalid content slug');
  if ((type === 'post' || type === 'log' || type === 'category') && value.includes('/')) throw new BadRequestException('This content type requires a single slug segment');
  if (type === 'page' && reservedPageRoots.has(value.split('/')[0]) || type === 'post' && value === 'category'
    || type === 'doc' && value.split('/')[0] === 'search')
    throw new BadRequestException('This slug belongs to an application route');
  return value;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 2147483647) throw new BadRequestException('An expected content revision is required');
  return Number(value);
}
export function page(value: unknown): number {
  const number = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100000) throw new BadRequestException('Invalid content page');
  return number;
}
/** Admin list page size: 1-100 rows, 20 when omitted. */
export function pageSize(value: unknown): number {
  const number = value === undefined || value === '' ? 20 : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100) throw new BadRequestException('Invalid content page size');
  return number;
}
export function boundedText(value: unknown, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || required && !value.trim())
    throw new BadRequestException('Invalid content text');
  return value.trim();
}
export function entryDraft(document: unknown, categories: unknown, type: ContentKind): EntryDraft {
  try {
    const parsed = validateSiteDocument(document);
    const list = categories ?? [];
    if (!Array.isArray(list) || list.length > 20 || new Set(list).size !== list.length) throw new BadRequestException('Invalid categories');
    const categoryIds = list.map(identifier);
    if (type !== 'post' && categoryIds.length) throw new BadRequestException('Only blog posts may have categories');
    return { document: parsed, categoryIds };
  } catch (error) {
    if (error instanceof SiteContentValidationError) throw new BadRequestException({ code: 'invalid_content', field: error.field, message: error.message });
    throw error;
  }
}
export function categoryDraft(title: unknown, description: unknown): CategoryDraft {
  return { title: boundedText(title, 120, true), description: boundedText(description, 500) };
}
