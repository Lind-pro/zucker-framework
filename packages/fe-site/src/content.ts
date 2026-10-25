/** Pure, versioned site-document data. Publishing, authorship and persistence remain consumer policy. */
export interface SiteAction {
  label: string;
  href: string;
}
interface BlockBase {
  id: string;
  enabled: boolean;
}
export type SiteBlock =
  | (BlockBase & { type: 'hero'; heading: string; text: string; action?: SiteAction })
  | (BlockBase & { type: 'markdown'; heading: string; markdown: string })
  | (BlockBase & {
      type: 'features';
      heading: string;
      items: Array<{ title: string; text: string }>;
    })
  | (BlockBase & {
      type: 'faq';
      heading: string;
      items: Array<{ question: string; answer: string }>;
    })
  | (BlockBase & { type: 'cta'; heading: string; text: string; action: SiteAction })
  | (BlockBase & { type: 'links'; heading: string; items: SiteAction[] });
export interface SiteDocument {
  version: 1;
  title: string;
  description: string;
  authorName: string;
  markdown: string;
  blocks: SiteBlock[];
  seo: { title: string; description: string; noIndex: boolean };
}
export class SiteContentValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'SiteContentValidationError';
  }
}
function invalid(field: string, message: string): never {
  throw new SiteContentValidationError(field, message);
}
function object(
  value: unknown,
  allowed: readonly string[],
  field: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return invalid(field, 'Expected a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key]))
      return invalid(field, 'Unexpected field');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    return invalid(field, 'Invalid text or length');
  const result = value.trim();
  if (required && !result) return invalid(field, 'Text is required');
  return result;
}
function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') return invalid(field, 'Expected a boolean');
  return value;
}
function list(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid(field, 'Invalid list');
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) return invalid(field, 'Sparse arrays are unsupported');
  if (Object.keys(value).length !== value.length)
    return invalid(field, 'Sparse or extended arrays are unsupported');
  return value;
}

/** HTTP(S), fragment and relative navigation only. No scripts, data URLs or embedded credentials. */
export function safeSiteHref(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    value !== value.trim() ||
    /[\\\u0000-\u0020\u007f]/.test(value) ||
    value.startsWith('//')
  )
    return null;
  try {
    const parsed = new URL(value, 'https://site.invalid');
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return null;
    return value;
  } catch {
    return null;
  }
}
function action(value: unknown, field: string): SiteAction {
  const raw = object(value, ['label', 'href'], field);
  const href = safeSiteHref(raw.href);
  if (!href) return invalid(`${field}.href`, 'Expected a safe web link');
  return { label: text(raw.label, `${field}.label`, 100, true), href };
}
function block(value: unknown, index: number): SiteBlock {
  const field = `blocks.${index}`;
  const base = object(
    value,
    ['id', 'type', 'enabled', 'heading', 'text', 'action', 'markdown', 'items'],
    field,
  );
  const id = text(base.id, `${field}.id`, 64, true);
  if (!/^[a-z][a-z0-9_-]*$/.test(id))
    return invalid(`${field}.id`, 'Expected a lowercase block identifier');
  const common = { id, enabled: bool(base.enabled, `${field}.enabled`, true) };
  const heading = text(base.heading, `${field}.heading`, 200, base.type !== 'markdown');
  const exact = (keys: string[]) =>
    object(value, ['id', 'type', 'enabled', 'heading', ...keys], field);
  switch (base.type) {
    case 'hero':
    case 'cta': {
      exact(['text', 'action']);
      const content = text(base.text, `${field}.text`, 4000);
      if (base.type === 'cta')
        return {
          ...common,
          type: 'cta',
          heading,
          text: content,
          action: action(base.action, `${field}.action`),
        };
      return {
        ...common,
        type: 'hero',
        heading,
        text: content,
        ...(base.action === undefined ? {} : { action: action(base.action, `${field}.action`) }),
      };
    }
    case 'markdown':
      exact(['markdown']);
      return {
        ...common,
        type: 'markdown',
        heading,
        markdown: text(base.markdown, `${field}.markdown`, 24000, true),
      };
    case 'features':
      exact(['items']);
      return {
        ...common,
        type: 'features',
        heading,
        items: list(base.items, `${field}.items`, 12).map((entry, item) => {
          const key = `${field}.items.${item}`,
            raw = object(entry, ['title', 'text'], key);
          return {
            title: text(raw.title, `${key}.title`, 160, true),
            text: text(raw.text, `${key}.text`, 4000, true),
          };
        }),
      };
    case 'faq':
      exact(['items']);
      return {
        ...common,
        type: 'faq',
        heading,
        items: list(base.items, `${field}.items`, 12).map((entry, item) => {
          const key = `${field}.items.${item}`,
            raw = object(entry, ['question', 'answer'], key);
          return {
            question: text(raw.question, `${key}.question`, 300, true),
            answer: text(raw.answer, `${key}.answer`, 4000, true),
          };
        }),
      };
    case 'links':
      exact(['items']);
      return {
        ...common,
        type: 'links',
        heading,
        items: list(base.items, `${field}.items`, 20).map((entry, item) =>
          action(entry, `${field}.items.${item}`),
        ),
      };
    default:
      return invalid(`${field}.type`, 'Unsupported site block');
  }
}

/** Validates known JSON fields, produces an independent snapshot, and bounds serialized UTF-8 size. */
export function validateSiteDocument(value: unknown): SiteDocument {
  const raw = object(
    value,
    ['version', 'title', 'description', 'authorName', 'markdown', 'blocks', 'seo'],
    'document',
  );
  if (raw.version !== 1) return invalid('version', 'Unsupported document version');
  const seo =
    raw.seo === undefined ? {} : object(raw.seo, ['title', 'description', 'noIndex'], 'seo');
  const blocks = raw.blocks === undefined ? [] : list(raw.blocks, 'blocks', 20).map(block);
  if (new Set(blocks.map((entry) => entry.id)).size !== blocks.length)
    return invalid('blocks', 'Block identifiers must be unique');
  const result: SiteDocument = {
    version: 1,
    title: text(raw.title, 'title', 200, true),
    description: text(raw.description, 'description', 500),
    authorName: text(raw.authorName, 'authorName', 120),
    markdown: text(raw.markdown, 'markdown', 48000),
    blocks,
    seo: {
      title: text(seo.title, 'seo.title', 200),
      description: text(seo.description, 'seo.description', 500),
      noIndex: bool(seo.noIndex, 'seo.noIndex', false),
    },
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536)
    return invalid('document', 'Document exceeds 64 KiB');
  return result;
}

/** Disabled authoring blocks are omitted from public snapshots, not merely hidden with CSS. */
export function visibleSiteDocument(document: SiteDocument): SiteDocument {
  const snapshot = validateSiteDocument(document);
  return { ...snapshot, blocks: snapshot.blocks.filter((entry) => entry.enabled) };
}
export function hasVisibleSiteContent(document: SiteDocument): boolean {
  return !!document.markdown.trim() || document.blocks.some((entry) => entry.enabled);
}
/** Text for the consumer's persisted search projection; never includes disabled block contents. */
export function siteDocumentText(document: SiteDocument): string {
  const parts = [document.title, document.description, document.authorName, document.markdown];
  for (const entry of document.blocks.filter((value) => value.enabled)) {
    parts.push(entry.heading);
    switch (entry.type) {
      case 'hero':
      case 'cta':
        parts.push(entry.text);
        if (entry.action) parts.push(entry.action.label);
        break;
      case 'markdown':
        parts.push(entry.markdown);
        break;
      case 'features':
        parts.push(...entry.items.flatMap((item) => [item.title, item.text]));
        break;
      case 'faq':
        parts.push(...entry.items.flatMap((item) => [item.question, item.answer]));
        break;
      case 'links':
        parts.push(...entry.items.map((item) => item.label));
        break;
    }
  }
  return parts.join('\n');
}
export type SiteColorMode = 'light' | 'dark' | 'system';
/** Resolve a named consumer renderer from an explicit registry, never an arbitrary import path. */
export function resolveSiteTheme(
  value: unknown,
  available: readonly string[],
  fallback = 'default',
) {
  if (!available.includes(fallback)) throw new Error('The fallback site theme is not registered');
  const found = typeof value === 'string' && available.includes(value);
  return { name: found ? value : fallback, usedFallback: !found };
}
export function resolveSiteColorMode(
  value: unknown,
  fallback: SiteColorMode = 'dark',
): SiteColorMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : fallback;
}
