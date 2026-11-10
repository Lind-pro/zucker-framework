/**
 * Pure, versioned site-document data. Publishing, authorship and persistence remain consumer policy.
 *
 * Version 1 has six block types. Version 2 adds landing blocks (`logo-cloud`, `stats`, `steps`,
 * `testimonials`, `showcase`, `pricing`, `newsletter`, `blog-list`, `changelog`, `media`) plus
 * optional `variant`/`image` on `hero` and `features` and `secondaryAction` on `hero`.
 * `validateSiteDocument` accepts both and always returns a version-2 snapshot: a version-1 input is
 * upgraded in memory by changing only `version` (no other field is added or rewritten). A version-1
 * input must still use only version-1 block types and fields.
 *
 * Content never executes: every block is plain text plus links/images that pass `safeSiteHref`;
 * there is no HTML, component name, script or style field. Markdown stays a string and is rendered
 * by the host with HTML disabled.
 */
export interface SiteAction {
  label: string;
  href: string;
}
/** An image reference. `src` passed `safeSiteHref`; an empty `alt` marks a decorative image. */
export interface SiteImage {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}
interface BlockBase {
  id: string;
  enabled: boolean;
}
export type SiteHeroVariant = 'centered' | 'split';
export type SiteFeaturesVariant = 'grid' | 'list';
export const SITE_HERO_VARIANTS: readonly SiteHeroVariant[] = Object.freeze(['centered', 'split']);
export const SITE_FEATURES_VARIANTS: readonly SiteFeaturesVariant[] = Object.freeze([
  'grid',
  'list',
]);

export type SiteHeroBlock = BlockBase & {
  type: 'hero';
  heading: string;
  text: string;
  action?: SiteAction;
  /** v2 */ secondaryAction?: SiteAction;
  /** v2; renderer default `centered` */ variant?: SiteHeroVariant;
  /** v2 */ image?: SiteImage;
};
export type SiteMarkdownBlock = BlockBase & { type: 'markdown'; heading: string; markdown: string };
export type SiteFeaturesBlock = BlockBase & {
  type: 'features';
  heading: string;
  items: Array<{ title: string; text: string }>;
  /** v2; renderer default `grid` */ variant?: SiteFeaturesVariant;
  /** v2 */ image?: SiteImage;
};
export type SiteFaqBlock = BlockBase & {
  type: 'faq';
  heading: string;
  items: Array<{ question: string; answer: string }>;
};
export type SiteCtaBlock = BlockBase & {
  type: 'cta';
  heading: string;
  text: string;
  action: SiteAction;
};
export type SiteLinksBlock = BlockBase & { type: 'links'; heading: string; items: SiteAction[] };
/** v2. `heading` may be empty. */
export type SiteLogoCloudBlock = BlockBase & {
  type: 'logo-cloud';
  heading: string;
  items: Array<{ name: string; image: SiteImage; href?: string }>;
};
/** v2. `value` is display text such as "99.9%" or "10k+", never a computed number. */
export type SiteStatsBlock = BlockBase & {
  type: 'stats';
  heading: string;
  text: string;
  items: Array<{ value: string; label: string }>;
};
export type SiteStepsBlock = BlockBase & {
  type: 'steps';
  heading: string;
  text: string;
  items: Array<{ title: string; text: string }>;
};
export type SiteTestimonialsBlock = BlockBase & {
  type: 'testimonials';
  heading: string;
  items: Array<{ quote: string; author: string; role: string; avatar?: SiteImage }>;
};
export type SiteShowcaseBlock = BlockBase & {
  type: 'showcase';
  heading: string;
  text: string;
  items: Array<{ title: string; text: string; image: SiteImage; href?: string }>;
};
/**
 * v2. References plans by slug (or every public plan) and never contains prices, currencies or
 * credits: the host resolves those from the billing catalog through the renderer's `pricing` slot.
 */
export type SitePricingBlock = BlockBase & {
  type: 'pricing';
  heading: string;
  text: string;
  plans: 'all' | string[];
  showCreditPacks: boolean;
};
/** v2. A plain `POST` form with one `email` field; `formAction` is https or a same-origin path. */
export type SiteNewsletterBlock = BlockBase & {
  type: 'newsletter';
  heading: string;
  text: string;
  formAction: string;
  emailLabel: string;
  buttonLabel: string;
};
/** v2. Data comes from the host through the renderer's `blogList` slot. */
export type SiteBlogListBlock = BlockBase & {
  type: 'blog-list';
  heading: string;
  text: string;
  limit: number;
  category?: string;
};
/** v2. Data comes from the host through the renderer's `changelog` slot. */
export type SiteChangelogBlock = BlockBase & {
  type: 'changelog';
  heading: string;
  text: string;
  limit: number;
};
/** v2. `heading` may be empty; `alt` is required and doubles as the video's accessible name. */
export type SiteMediaBlock = BlockBase & {
  type: 'media';
  heading: string;
  kind: 'image' | 'video';
  src: string;
  alt: string;
  caption: string;
  poster?: string;
  width?: number;
  height?: number;
};

export type SiteBlock =
  | SiteHeroBlock
  | SiteMarkdownBlock
  | SiteFeaturesBlock
  | SiteFaqBlock
  | SiteCtaBlock
  | SiteLinksBlock
  | SiteLogoCloudBlock
  | SiteStatsBlock
  | SiteStepsBlock
  | SiteTestimonialsBlock
  | SiteShowcaseBlock
  | SitePricingBlock
  | SiteNewsletterBlock
  | SiteBlogListBlock
  | SiteChangelogBlock
  | SiteMediaBlock;
export type SiteBlockType = SiteBlock['type'];
export type SiteBlockOf<T extends SiteBlockType> = Extract<SiteBlock, { type: T }>;

export const SITE_BLOCK_TYPES_V1 = Object.freeze([
  'hero',
  'markdown',
  'features',
  'faq',
  'cta',
  'links',
] as const satisfies readonly SiteBlockType[]);
export const SITE_BLOCK_TYPES: readonly SiteBlockType[] = Object.freeze([
  ...SITE_BLOCK_TYPES_V1,
  'logo-cloud',
  'stats',
  'steps',
  'testimonials',
  'showcase',
  'pricing',
  'newsletter',
  'blog-list',
  'changelog',
  'media',
] as const satisfies readonly SiteBlockType[]);

/** Validation limits, exported so editors can mirror them. Text limits are UTF-16 code units. */
export const SITE_CONTENT_LIMITS = Object.freeze({
  documentBytes: 65536,
  blocksV1: 20,
  blocksV2: 32,
  blockId: 64,
  heading: 200,
  text: 4000,
  blockMarkdown: 24000,
  documentMarkdown: 48000,
  label: 100,
  href: 2048,
  imageAlt: 300,
  imageDimension: 8192,
  slug: 64,
  featureItems: 12,
  faqItems: 12,
  linkItems: 20,
  logoItems: 24,
  statItems: 8,
  stepItems: 12,
  testimonialItems: 12,
  showcaseItems: 12,
  pricingPlans: 12,
  blogListLimit: 12,
  changelogLimit: 20,
});
const L = SITE_CONTENT_LIMITS;

export interface SiteDocument {
  /** Inputs may be 1 or 2; `validateSiteDocument` always returns 2. */
  version: 1 | 2;
  title: string;
  description: string;
  authorName: string;
  markdown: string;
  blocks: SiteBlock[];
  seo: { title: string; description: string; noIndex: boolean };
}
/** The output of `validateSiteDocument`: always upgraded to version 2. */
export type ValidatedSiteDocument = SiteDocument & { version: 2 };

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
function integer(value: unknown, field: string, min: number, max: number, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid(field, `Expected an integer from ${min} to ${max}`);
  return value;
}
function choice<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value))
    return invalid(field, `Expected one of: ${options.join(', ')}`);
  return value as T;
}
function list(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid(field, 'Invalid list');
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) return invalid(field, 'Sparse arrays are unsupported');
  if (Object.keys(value).length !== value.length)
    return invalid(field, 'Sparse or extended arrays are unsupported');
  return value;
}
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function slug(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SLUG.test(value))
    return invalid(field, 'Expected a lowercase slug');
  return value;
}

/** HTTP(S), fragment and relative navigation only. No scripts, data URLs or embedded credentials. */
export function safeSiteHref(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    value !== value.trim() ||
    /[\\\u0000- \u007f]/.test(value) ||
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
/**
 * Form targets: an absolute `https:` URL or a same-origin absolute path (`/api/newsletter`).
 * Stricter than `safeSiteHref`: no `http:`, fragment-only or document-relative targets.
 */
export function safeSiteFormAction(value: unknown): string | null {
  const href = safeSiteHref(value);
  if (!href) return null;
  if (href.startsWith('/')) return href;
  return /^https:/i.test(href) && new URL(href).protocol === 'https:' ? href : null;
}
function href(value: unknown, field: string): string {
  const result = safeSiteHref(value);
  if (!result) return invalid(field, 'Expected a safe web link');
  return result;
}
function optionalHref(value: unknown, field: string): { href?: string } {
  return value === undefined ? {} : { href: href(value, field) };
}
function action(value: unknown, field: string): SiteAction {
  const raw = object(value, ['label', 'href'], field);
  return {
    label: text(raw.label, `${field}.label`, L.label, true),
    href: href(raw.href, `${field}.href`),
  };
}
function dimensions(raw: Record<string, unknown>, field: string) {
  return {
    ...(raw.width === undefined
      ? {}
      : { width: integer(raw.width, `${field}.width`, 1, L.imageDimension) }),
    ...(raw.height === undefined
      ? {}
      : { height: integer(raw.height, `${field}.height`, 1, L.imageDimension) }),
  };
}
function image(value: unknown, field: string): SiteImage {
  const raw = object(value, ['src', 'alt', 'width', 'height'], field);
  return {
    src: href(raw.src, `${field}.src`),
    alt: text(raw.alt, `${field}.alt`, L.imageAlt),
    ...dimensions(raw, field),
  };
}
function optionalImage(value: unknown, field: string, key: 'image' | 'avatar') {
  return value === undefined ? {} : { [key]: image(value, `${field}.${key}`) };
}
function items<T>(
  value: unknown,
  field: string,
  max: number,
  keys: readonly string[],
  map: (raw: Record<string, unknown>, key: string) => T,
): T[] {
  return list(value, `${field}.items`, max).map((entry, index) => {
    const key = `${field}.items.${index}`;
    return map(object(entry, keys, key), key);
  });
}
const titleText = (raw: Record<string, unknown>, key: string) => ({
  title: text(raw.title, `${key}.title`, 160, true),
  text: text(raw.text, `${key}.text`, L.text, true),
});

/** Fields every block may carry, in addition to its type-specific fields. */
const COMMON = ['id', 'type', 'enabled', 'heading'] as const;
/** Type-specific field allow-lists. Version 1 is a strict subset of version 2. */
const FIELDS_V1: Record<(typeof SITE_BLOCK_TYPES_V1)[number], readonly string[]> = {
  hero: ['text', 'action'],
  cta: ['text', 'action'],
  markdown: ['markdown'],
  features: ['items'],
  faq: ['items'],
  links: ['items'],
};
const FIELDS_V2: Record<SiteBlockType, readonly string[]> = {
  ...FIELDS_V1,
  hero: ['text', 'action', 'secondaryAction', 'variant', 'image'],
  features: ['items', 'variant', 'image'],
  'logo-cloud': ['items'],
  stats: ['text', 'items'],
  steps: ['text', 'items'],
  testimonials: ['items'],
  showcase: ['text', 'items'],
  pricing: ['text', 'plans', 'showCreditPacks'],
  newsletter: ['text', 'formAction', 'emailLabel', 'buttonLabel'],
  'blog-list': ['text', 'limit', 'category'],
  changelog: ['text', 'limit'],
  media: ['kind', 'src', 'alt', 'caption', 'poster', 'width', 'height'],
};
/** Blocks whose `heading` may be empty. */
const OPTIONAL_HEADING: ReadonlySet<string> = new Set(['markdown', 'logo-cloud', 'media']);

function block(value: unknown, index: number, version: 1 | 2): SiteBlock {
  const field = `blocks.${index}`;
  const fields: Record<string, readonly string[]> = version === 1 ? FIELDS_V1 : FIELDS_V2;
  const loose = object(value, [...new Set([...COMMON, ...Object.values(fields).flat()])], field);
  if (typeof loose.type !== 'string' || !Object.hasOwn(fields, loose.type))
    return invalid(`${field}.type`, 'Unsupported site block');
  const type = loose.type as SiteBlockType;
  const base = object(value, [...COMMON, ...fields[type]], field);
  const id = text(base.id, `${field}.id`, L.blockId, true);
  if (!/^[a-z][a-z0-9_-]*$/.test(id))
    return invalid(`${field}.id`, 'Expected a lowercase block identifier');
  const common = { id, enabled: bool(base.enabled, `${field}.enabled`, true) };
  const heading = text(base.heading, `${field}.heading`, L.heading, !OPTIONAL_HEADING.has(type));
  const body = () => text(base.text, `${field}.text`, L.text);
  switch (type) {
    case 'hero':
      return {
        ...common,
        type,
        heading,
        text: body(),
        ...(base.action === undefined ? {} : { action: action(base.action, `${field}.action`) }),
        ...(base.secondaryAction === undefined
          ? {}
          : { secondaryAction: action(base.secondaryAction, `${field}.secondaryAction`) }),
        ...(base.variant === undefined
          ? {}
          : { variant: choice(base.variant, `${field}.variant`, SITE_HERO_VARIANTS) }),
        ...optionalImage(base.image, field, 'image'),
      };
    case 'cta':
      return {
        ...common,
        type,
        heading,
        text: body(),
        action: action(base.action, `${field}.action`),
      };
    case 'markdown':
      return {
        ...common,
        type,
        heading,
        markdown: text(base.markdown, `${field}.markdown`, L.blockMarkdown, true),
      };
    case 'features':
      return {
        ...common,
        type,
        heading,
        items: items(base.items, field, L.featureItems, ['title', 'text'], titleText),
        ...(base.variant === undefined
          ? {}
          : { variant: choice(base.variant, `${field}.variant`, SITE_FEATURES_VARIANTS) }),
        ...optionalImage(base.image, field, 'image'),
      };
    case 'faq':
      return {
        ...common,
        type,
        heading,
        items: items(base.items, field, L.faqItems, ['question', 'answer'], (raw, key) => ({
          question: text(raw.question, `${key}.question`, 300, true),
          answer: text(raw.answer, `${key}.answer`, L.text, true),
        })),
      };
    case 'links':
      return {
        ...common,
        type,
        heading,
        items: list(base.items, `${field}.items`, L.linkItems).map((entry, item) =>
          action(entry, `${field}.items.${item}`),
        ),
      };
    case 'logo-cloud':
      return {
        ...common,
        type,
        heading,
        items: items(base.items, field, L.logoItems, ['name', 'image', 'href'], (raw, key) => ({
          name: text(raw.name, `${key}.name`, 120, true),
          image: image(raw.image, `${key}.image`),
          ...optionalHref(raw.href, `${key}.href`),
        })),
      };
    case 'stats':
      return {
        ...common,
        type,
        heading,
        text: body(),
        items: items(base.items, field, L.statItems, ['value', 'label'], (raw, key) => ({
          value: text(raw.value, `${key}.value`, 32, true),
          label: text(raw.label, `${key}.label`, 120, true),
        })),
      };
    case 'steps':
      return {
        ...common,
        type,
        heading,
        text: body(),
        items: items(base.items, field, L.stepItems, ['title', 'text'], titleText),
      };
    case 'testimonials':
      return {
        ...common,
        type,
        heading,
        items: items(
          base.items,
          field,
          L.testimonialItems,
          ['quote', 'author', 'role', 'avatar'],
          (raw, key) => ({
            quote: text(raw.quote, `${key}.quote`, 1200, true),
            author: text(raw.author, `${key}.author`, 120, true),
            role: text(raw.role, `${key}.role`, 160),
            ...optionalImage(raw.avatar, key, 'avatar'),
          }),
        ),
      };
    case 'showcase':
      return {
        ...common,
        type,
        heading,
        text: body(),
        items: items(
          base.items,
          field,
          L.showcaseItems,
          ['title', 'text', 'image', 'href'],
          (raw, key) => ({
            title: text(raw.title, `${key}.title`, 160, true),
            text: text(raw.text, `${key}.text`, 1000),
            image: image(raw.image, `${key}.image`),
            ...optionalHref(raw.href, `${key}.href`),
          }),
        ),
      };
    case 'pricing': {
      let plans: SitePricingBlock['plans'];
      if (base.plans === 'all') plans = 'all';
      else {
        plans = list(base.plans, `${field}.plans`, L.pricingPlans).map((entry, item) =>
          slug(entry, `${field}.plans.${item}`),
        );
        if (!plans.length) return invalid(`${field}.plans`, 'Select at least one plan or "all"');
        if (new Set(plans).size !== plans.length)
          return invalid(`${field}.plans`, 'Plan slugs must be unique');
      }
      return {
        ...common,
        type,
        heading,
        text: body(),
        plans,
        showCreditPacks: bool(base.showCreditPacks, `${field}.showCreditPacks`, false),
      };
    }
    case 'newsletter': {
      const formAction = safeSiteFormAction(base.formAction);
      if (!formAction)
        return invalid(`${field}.formAction`, 'Expected an https URL or a same-origin path');
      return {
        ...common,
        type,
        heading,
        text: body(),
        formAction,
        emailLabel: text(base.emailLabel, `${field}.emailLabel`, L.label, true),
        buttonLabel: text(base.buttonLabel, `${field}.buttonLabel`, L.label, true),
      };
    }
    case 'blog-list':
      return {
        ...common,
        type,
        heading,
        text: body(),
        limit: integer(base.limit, `${field}.limit`, 1, L.blogListLimit, 3),
        ...(base.category === undefined
          ? {}
          : { category: slug(base.category, `${field}.category`) }),
      };
    case 'changelog':
      return {
        ...common,
        type,
        heading,
        text: body(),
        limit: integer(base.limit, `${field}.limit`, 1, L.changelogLimit, 5),
      };
    case 'media':
      return {
        ...common,
        type,
        heading,
        kind: choice(base.kind, `${field}.kind`, ['image', 'video'] as const),
        src: href(base.src, `${field}.src`),
        alt: text(base.alt, `${field}.alt`, L.imageAlt, true),
        caption: text(base.caption, `${field}.caption`, 500),
        ...(base.poster === undefined ? {} : { poster: href(base.poster, `${field}.poster`) }),
        ...dimensions(base, field),
      };
  }
}

/**
 * Validates known JSON fields, produces an independent snapshot, and bounds serialized UTF-8 size.
 * Accepts version 1 and 2 and always returns version 2. Throws `SiteContentValidationError` whose
 * `field` is a dotted path such as `blocks.3.items.0.image.src`.
 */
export function validateSiteDocument(value: unknown): ValidatedSiteDocument {
  const raw = object(
    value,
    ['version', 'title', 'description', 'authorName', 'markdown', 'blocks', 'seo'],
    'document',
  );
  if (raw.version !== 1 && raw.version !== 2)
    return invalid('version', 'Unsupported document version');
  const version = raw.version;
  const seo =
    raw.seo === undefined ? {} : object(raw.seo, ['title', 'description', 'noIndex'], 'seo');
  const blocks =
    raw.blocks === undefined
      ? []
      : list(raw.blocks, 'blocks', version === 1 ? L.blocksV1 : L.blocksV2).map((entry, index) =>
          block(entry, index, version),
        );
  if (new Set(blocks.map((entry) => entry.id)).size !== blocks.length)
    return invalid('blocks', 'Block identifiers must be unique');
  const result: ValidatedSiteDocument = {
    version: 2,
    title: text(raw.title, 'title', 200, true),
    description: text(raw.description, 'description', 500),
    authorName: text(raw.authorName, 'authorName', 120),
    markdown: text(raw.markdown, 'markdown', L.documentMarkdown),
    blocks,
    seo: {
      title: text(seo.title, 'seo.title', 200),
      description: text(seo.description, 'seo.description', 500),
      noIndex: bool(seo.noIndex, 'seo.noIndex', false),
    },
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > L.documentBytes)
    return invalid('document', 'Document exceeds 64 KiB');
  return result;
}

/** Disabled authoring blocks are omitted from public snapshots, not merely hidden with CSS. */
export function visibleSiteDocument(document: SiteDocument): ValidatedSiteDocument {
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
        if (entry.type === 'hero' && entry.secondaryAction) parts.push(entry.secondaryAction.label);
        break;
      case 'markdown':
        parts.push(entry.markdown);
        break;
      case 'features':
      case 'steps':
        if (entry.type === 'steps') parts.push(entry.text);
        parts.push(...entry.items.flatMap((item) => [item.title, item.text]));
        break;
      case 'faq':
        parts.push(...entry.items.flatMap((item) => [item.question, item.answer]));
        break;
      case 'links':
        parts.push(...entry.items.map((item) => item.label));
        break;
      case 'logo-cloud':
        parts.push(...entry.items.map((item) => item.name));
        break;
      case 'stats':
        parts.push(entry.text, ...entry.items.flatMap((item) => [item.value, item.label]));
        break;
      case 'testimonials':
        parts.push(...entry.items.flatMap((item) => [item.quote, item.author, item.role]));
        break;
      case 'showcase':
        parts.push(entry.text, ...entry.items.flatMap((item) => [item.title, item.text]));
        break;
      case 'pricing':
      case 'newsletter':
      case 'blog-list':
      case 'changelog':
        parts.push(entry.text);
        break;
      case 'media':
        parts.push(entry.alt, entry.caption);
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
