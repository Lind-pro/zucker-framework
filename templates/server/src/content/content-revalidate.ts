import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { CONTENT_OPTIONS, type ContentOptions } from './content.options';
import type { ContentKind, ContentLocale } from './content.types';

/**
 * Web cache revalidation protocol (verified by the Web template's `POST /api/revalidate`):
 *   body       JSON `{"tags":[...]}` (1..REVALIDATE_MAX_TAGS tags matching REVALIDATE_TAG_PATTERN)
 *   header     `x-revalidate-timestamp`: Unix time in whole seconds; receivers accept ±300 s
 *   header     `x-revalidate-signature`: `v1=` + hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * Receivers compare the signature in constant time over the exact raw body bytes.
 */
export const REVALIDATE_PATH = '/api/revalidate';
export const REVALIDATE_TIMEOUT_MS = 3000;
export const REVALIDATE_MAX_TAGS = 32;
export const REVALIDATE_TAG_PATTERN = /^[a-z0-9][a-z0-9:/_-]{0,255}$/;

export function signRevalidation(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Cache tags. Every content response may carry `content`; narrower tags let the Web refresh less. */
export const contentTags = {
  all: 'content',
  settings: 'content:settings',
  sitemap: 'content:sitemap',
  list: (kind: ContentKind, locale: ContentLocale) => `content:list:${kind}:${locale}`,
  entry: (kind: ContentKind, locale: ContentLocale, slug: string) => `content:entry:${kind}:${locale}:${slug}`,
  categories: (locale: ContentLocale) => `content:categories:${locale}`,
  search: (locale: ContentLocale) => `content:search:${locale}`,
};

export function entryTags(kind: ContentKind, locale: ContentLocale, slugs: Array<string | null | undefined>): string[] {
  const tags = [contentTags.all, contentTags.sitemap, contentTags.list(kind, locale)];
  for (const slug of new Set(slugs)) if (slug) tags.push(contentTags.entry(kind, locale, slug));
  if (kind === 'doc') tags.push(contentTags.search(locale));
  return tags;
}

/** Best-effort, signed notification to the Web app after a public content change. Never throws. */
@Injectable()
export class ContentRevalidator {
  private readonly logger = new Logger('ContentRevalidator');
  private readonly endpoint: string;
  /** Replaceable in tests; production uses the platform fetch. */
  transport: typeof fetch = (...args) => fetch(...args);
  constructor(@Inject(CONTENT_OPTIONS) private readonly options: ContentOptions) {
    // Only the configured WEB_URL origin is ever contacted; the path is fixed.
    this.endpoint = new URL(REVALIDATE_PATH, options.siteUrl).href;
  }

  get enabled(): boolean { return !!this.options.revalidateSecret; }

  /** Resolves once the request finished or failed; callers do not await it on the write path. */
  async notify(tags: readonly string[], now = Date.now()): Promise<boolean> {
    const secret = this.options.revalidateSecret;
    if (!secret) return false;
    const unique = [...new Set(tags)].filter(tag => REVALIDATE_TAG_PATTERN.test(tag)).slice(0, REVALIDATE_MAX_TAGS);
    if (!unique.length) return false;
    const body = JSON.stringify({ tags: unique }), timestamp = Math.floor(now / 1000);
    try {
      const response = await this.transport(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REVALIDATE_TIMEOUT_MS),
        headers: { 'content-type': 'application/json', 'x-revalidate-timestamp': String(timestamp), 'x-revalidate-signature': signRevalidation(secret, timestamp, body) },
        body });
      if (!response.ok) { this.logger.warn(`Web revalidation returned HTTP ${response.status}`); return false; }
      return true;
    } catch (error) {
      this.logger.warn(`Web revalidation failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      return false;
    }
  }

  /** Fire-and-forget wrapper for write paths: the content write has already committed. */
  schedule(tags: readonly string[]): void { void this.notify(tags); }
}
