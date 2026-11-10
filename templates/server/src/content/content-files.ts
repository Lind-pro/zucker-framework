import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { hasVisibleSiteContent, siteDocumentText, validateSiteDocument, visibleSiteDocument, type SiteDocument } from '@zucker-framework/fe-site/content';
import { CONTENT_OPTIONS, type ContentOptions } from './content.options';
import type { ContentKind, ContentLocale } from './content.types';
import * as input from './content.validation';

/**
 * Documents shipped with the app in `content/<folder>/<slug>.<locale>.<md|json>`.
 * They are read once at startup, validated exactly like CMS documents, and served as published
 * entries unless a *published* database entry claims the same kind/locale/slug (database wins).
 */
export const CONTENT_FOLDERS: Readonly<Record<string, ContentKind>> = { pages: 'page', posts: 'post', docs: 'doc', logs: 'log' };
export const FILE_LIMITS = Object.freeze({ maxFiles: 500, maxBytes: 256 * 1024, maxDepth: 4 });
const FILE_NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(zh|en)\.(md|json)$/;
const DIRECTORY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface FileEntry {
  id: string;
  kind: ContentKind;
  locale: ContentLocale;
  slug: string;
  /** Visible (enabled blocks only) validated snapshot. */
  document: SiteDocument;
  publishedAt: Date;
  searchText: string;
  /** Path relative to the content directory, with `/` separators. */
  source: string;
}
export interface FileIssue { source: string; message: string }
export interface FileLoadResult { entries: FileEntry[]; issues: FileIssue[] }

export class ContentFileError extends Error {}
const fail = (message: string): never => { throw new ContentFileError(message); };

const FRONT_MATTER_KEYS = ['title', 'description', 'publishedAt', 'authorName', 'noIndex'] as const;
type FrontMatterKey = typeof FRONT_MATTER_KEYS[number];
export interface FrontMatter { attributes: Partial<Record<FrontMatterKey, string | boolean>>; body: string }

/**
 * Minimal, non-executing front matter: `key: value` lines between `---` fences. Values are plain
 * text, a JSON double-quoted string, a single-quoted string, or `true`/`false`. No YAML features.
 */
export function parseFrontMatter(raw: string): FrontMatter {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return fail('Markdown files must start with a front matter block');
  const end = text.indexOf('\n---', 3);
  if (end < 0 || (text[end + 4] !== undefined && text[end + 4] !== '\n')) return fail('Unterminated front matter');
  const attributes: FrontMatter['attributes'] = {};
  for (const [index, line] of text.slice(4, end).split('\n').entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z]+):[ \t]*(.*)$/.exec(line);
    if (!match) return fail(`Invalid front matter line ${index + 2}`);
    const key = match[1] as FrontMatterKey, value = match[2].trim();
    if (!FRONT_MATTER_KEYS.includes(key)) return fail(`Unsupported front matter key "${match[1]}"`);
    if (Object.hasOwn(attributes, key)) return fail(`Duplicate front matter key "${key}"`);
    attributes[key] = frontMatterValue(value, key);
  }
  return { attributes, body: text.slice(end + 4).replace(/^\n/, '') };
}
function frontMatterValue(value: string, key: string): string | boolean {
  if (value === 'true' || value === 'false') return value === 'true';
  if (value.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch { /* reported below */ }
    return fail(`Invalid quoted value for "${key}"`);
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) return fail(`Invalid quoted value for "${key}"`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function publishedAt(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))
    return fail('publishedAt must be an ISO date (YYYY-MM-DD or a full timestamp with offset)');
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return fail('publishedAt is not a valid date');
  return date;
}
function stringAttribute(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return fail(`${key} must be text`);
  return value;
}

/** Builds a validated document from one file's text. Pure; used by the loader and by tests. */
export function parseContentFile(text: string, format: 'md' | 'json'): { document: SiteDocument; publishedAt: Date } {
  let document: unknown, date: unknown;
  if (format === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^﻿/, '')); } catch { return fail('Invalid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== 'publishedAt' && key !== 'document'))
      return fail('JSON files contain exactly {"publishedAt": "...", "document": {...}}');
    ({ publishedAt: date, document } = parsed as { publishedAt?: unknown; document?: unknown });
  } else {
    const { attributes, body } = parseFrontMatter(text);
    const noIndex = attributes.noIndex;
    if (noIndex !== undefined && typeof noIndex !== 'boolean') return fail('noIndex must be true or false');
    date = attributes.publishedAt;
    document = { version: 1, title: stringAttribute(attributes.title, 'title'), description: stringAttribute(attributes.description, 'description') ?? '',
      authorName: stringAttribute(attributes.authorName, 'authorName') ?? '', markdown: body, blocks: [],
      seo: { title: '', description: '', noIndex: noIndex ?? false } };
  }
  let validated: SiteDocument;
  try { validated = visibleSiteDocument(validateSiteDocument(document)); }
  catch (error) { return fail(`Invalid document: ${error instanceof Error ? error.message : 'validation failed'}${field(error)}`); }
  if (!hasVisibleSiteContent(validated)) return fail('Document has no visible content');
  return { document: validated, publishedAt: publishedAt(date) };
}
function field(error: unknown): string {
  const value = (error as { field?: unknown } | null)?.field;
  return typeof value === 'string' ? ` (${value})` : '';
}

/** True only when `candidate` is `root` itself or strictly below it. */
export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!!path && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/**
 * Reads every supported file below `directory`. Symbolic links are never followed, every resolved
 * path must stay inside the real directory, and sizes/counts/depth are bounded. Problems with one
 * file are reported and that file is skipped; a missing directory yields no entries.
 */
export async function loadContentDirectory(directory: string): Promise<FileLoadResult> {
  const entries: FileEntry[] = [], issues: FileIssue[] = [], seen = new Map<string, string>();
  let root: string;
  try { root = await realpath(directory); } catch { return { entries, issues }; }
  if (!(await lstat(root)).isDirectory()) return { entries, issues: [{ source: '.', message: 'Content path is not a directory' }] };
  let files = 0;
  const walk = async (folder: string, kind: ContentKind, segments: string[]): Promise<void> => {
    let children;
    try { children = await readdir(folder, { withFileTypes: true }); } catch { issues.push({ source: display(root, folder), message: 'Unreadable directory' }); return; }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, child.name), source = display(root, path);
      if (!isInside(root, path)) { issues.push({ source, message: 'Path escapes the content directory' }); continue; }
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) { issues.push({ source, message: 'Symbolic links are not followed' }); continue; }
      if (stat.isDirectory()) {
        if (!DIRECTORY_NAME.test(child.name)) { issues.push({ source, message: 'Unsupported directory name' }); continue; }
        if (segments.length + 1 >= FILE_LIMITS.maxDepth) { issues.push({ source, message: 'Directory nesting is too deep' }); continue; }
        await walk(path, kind, [...segments, child.name]);
        continue;
      }
      if (!stat.isFile()) { issues.push({ source, message: 'Not a regular file' }); continue; }
      if (child.name.startsWith('.') || /^readme\.md$/i.test(child.name)) continue;
      const match = FILE_NAME.exec(child.name);
      if (!match) { issues.push({ source, message: 'File name must be <slug>.<zh|en>.<md|json>' }); continue; }
      if (++files > FILE_LIMITS.maxFiles) { issues.push({ source, message: `More than ${FILE_LIMITS.maxFiles} content files` }); return; }
      if (stat.size > FILE_LIMITS.maxBytes) { issues.push({ source, message: 'File is larger than 256 KiB' }); continue; }
      const [, name, locale, format] = match as unknown as [string, string, ContentLocale, 'md' | 'json'];
      try {
        const slug = slugFor(kind, [...segments, name].join('/'));
        const key = `${kind}:${locale}:${slug}`;
        if (seen.has(key)) { issues.push({ source, message: `Duplicates ${seen.get(key)}` }); continue; }
        // Re-check after reading the real path: a rename race must not swap in a link to elsewhere.
        if (!isInside(root, await realpath(path))) { issues.push({ source, message: 'Path escapes the content directory' }); continue; }
        const parsed = parseContentFile(await readFile(path, 'utf8'), format);
        seen.set(key, source);
        entries.push({ id: `file:${key}`, kind, locale, slug, document: parsed.document, publishedAt: parsed.publishedAt,
          searchText: siteDocumentText(parsed.document), source });
      } catch (error) {
        issues.push({ source, message: error instanceof ContentFileError ? error.message : 'Unreadable or invalid file' });
      }
    }
  };
  for (const [folder, kind] of Object.entries(CONTENT_FOLDERS)) {
    const path = join(root, folder);
    const stat = await lstat(path).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) { issues.push({ source: folder, message: 'Content folders must be real directories' }); continue; }
    await walk(path, kind, []);
  }
  return { entries, issues };
}
function slugFor(kind: ContentKind, value: string): string {
  try { return input.slug(value, kind); } catch { return fail(`"${value}" is not a valid ${kind} slug`); }
}
function display(root: string, path: string): string { return relative(root, path).split(sep).join('/') || '.'; }

/** Startup-loaded, immutable view of the content directory. */
@Injectable()
export class ContentFileSource implements OnModuleInit {
  private readonly logger = new Logger('ContentFileSource');
  private loaded: FileLoadResult = { entries: [], issues: [] };
  private readonly index = new Map<string, FileEntry>();
  constructor(@Inject(CONTENT_OPTIONS) private readonly options: ContentOptions) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.contentDirectory) return;
    this.replace(await loadContentDirectory(this.options.contentDirectory));
    for (const issue of this.loaded.issues) this.logger.error(`Skipped content file ${issue.source}: ${issue.message}`);
    if (this.loaded.entries.length) this.logger.log(`Loaded ${this.loaded.entries.length} file-backed content documents`);
  }
  /** Replaces the loaded set (startup, tests). */
  replace(result: FileLoadResult): void {
    this.loaded = { entries: [...result.entries], issues: [...result.issues] };
    this.index.clear();
    for (const entry of this.loaded.entries) this.index.set(`${entry.kind}:${entry.locale}:${entry.slug}`, entry);
  }
  get issues(): readonly FileIssue[] { return this.loaded.issues; }
  all(): readonly FileEntry[] { return this.loaded.entries; }
  find(kind: ContentKind, locale: ContentLocale, slug: string): FileEntry | undefined { return this.index.get(`${kind}:${locale}:${slug}`); }
  /** Newest first, then slug: the same order public lists use. */
  list(kind: ContentKind, locale: ContentLocale): FileEntry[] {
    return this.loaded.entries.filter(entry => entry.kind === kind && entry.locale === locale)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || a.slug.localeCompare(b.slug));
  }
}
