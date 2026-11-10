import {
  SITE_BLOCK_TYPES,
  SiteContentValidationError,
  validateSiteDocument,
  type SiteBlockType,
  type SiteDocument,
  type ValidatedSiteDocument,
} from '@zucker-framework/fe-site/content';
import {
  ACTION_FIELDS,
  BLOCK_SPECS,
  IMAGE_FIELDS,
  type FieldSpec,
  type Label,
} from './block-fields';

/**
 * A block while it is edited: the schema's block shape, loosened so half-filled forms (an empty
 * required field, a number typed as text) can be held until `validateSiteDocument` reports them.
 */
export type BlockDraft = Record<string, unknown> & {
  id: string;
  type: SiteBlockType;
  enabled: boolean;
};
export type DocumentDraft = Omit<SiteDocument, 'blocks'> & { blocks: BlockDraft[] };

/** A validation failure with the schema's dotted field path (for example `blocks.2.items.0.title`). */
export interface DocumentIssue {
  field: string;
  message: string;
}
export type DocumentCheck =
  { ok: true; document: ValidatedSiteDocument } | { ok: false; issue: DocumentIssue };

export function emptyDocumentDraft(): DocumentDraft {
  return {
    version: 2,
    title: '',
    description: '',
    authorName: '',
    markdown: '',
    blocks: [],
    seo: { title: '', description: '', noIndex: false },
  };
}

/** Editor state from a stored (v1 or v2) document; blocks are copied so edits never mutate the source. */
export function toDocumentDraft(document: SiteDocument | undefined): DocumentDraft {
  if (!document) return emptyDocumentDraft();
  return {
    ...document,
    version: 2,
    seo: { ...document.seo },
    blocks: JSON.parse(JSON.stringify(document.blocks)) as BlockDraft[],
  };
}

/**
 * The only gate before save and preview: the shared fe-site validator. Always submits version 2 (a
 * version-1 document is a subset, so loading and re-saving it is lossless).
 */
export function checkDocument(draft: DocumentDraft): DocumentCheck {
  try {
    return { ok: true, document: validateSiteDocument({ ...draft, version: 2 }) };
  } catch (error) {
    if (error instanceof SiteContentValidationError)
      return { ok: false, issue: { field: error.field, message: error.message } };
    return {
      ok: false,
      issue: { field: 'document', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** A lowercase id unique within the document (`hero`, `hero-2`, …), as the schema requires. */
export function uniqueBlockId(type: SiteBlockType, blocks: readonly { id: string }[]): string {
  const used = new Set(blocks.map((block) => block.id));
  if (!used.has(type)) return type;
  for (let n = 2; ; n++) if (!used.has(`${type}-${n}`)) return `${type}-${n}`;
}

export function createBlock(type: SiteBlockType, blocks: readonly { id: string }[]): BlockDraft {
  return { id: uniqueBlockId(type, blocks), type, enabled: true, ...BLOCK_SPECS[type].create() };
}

export function moveBlock<T>(blocks: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= blocks.length || from === to) return [...blocks];
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/** Whether a parsed value can be edited by the forms (array of objects with a supported `type`). */
export function isEditableBlockList(value: unknown): value is BlockDraft[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as { type?: unknown }).type === 'string' &&
        (SITE_BLOCK_TYPES as readonly string[]).includes((entry as { type: string }).type),
    )
  );
}

const DOCUMENT_LABELS: Record<string, Label> = {
  document: ['文档', 'Document'],
  version: ['版本', 'Version'],
  title: ['标题', 'Title'],
  description: ['简介', 'Summary'],
  authorName: ['作者', 'Author'],
  markdown: ['正文', 'Body'],
  blocks: ['内容块', 'Blocks'],
  seo: ['SEO', 'SEO'],
  'seo.title': ['SEO 标题', 'SEO title'],
  'seo.description': ['SEO 描述', 'SEO description'],
  'seo.noIndex': ['不被搜索引擎收录', 'Hide from search engines'],
};
const COMMON_LABELS: Record<string, Label> = {
  id: ['锚点 ID', 'Anchor ID'],
  type: ['类型', 'Type'],
  enabled: ['显示', 'Shown'],
};

/**
 * Human-readable location of a validation path, built from the field table:
 * `blocks.2.items.0.image.src` → "Block 3 · Showcase › Item 1 › Cover image › Image URL".
 */
export function describeField(
  field: string,
  blocks: readonly { type?: unknown }[],
  tx: (zh: string, en: string) => string,
): string {
  const say = (label: Label) => tx(label[0], label[1]);
  if (DOCUMENT_LABELS[field]) return say(DOCUMENT_LABELS[field]);
  const segments = field.split('.');
  if (segments[0] !== 'blocks' || segments.length < 2) return field;
  const index = Number(segments[1]);
  const type = blocks[index]?.type;
  const spec = typeof type === 'string' ? BLOCK_SPECS[type as SiteBlockType] : undefined;
  const parts = [`${tx('内容块', 'Block')} ${index + 1}${spec ? ` · ${say(spec.label)}` : ''}`];
  let fields: readonly FieldSpec[] | undefined = spec?.fields;
  let list: Extract<FieldSpec, { kind: 'list' }> | undefined;
  for (let position = 2; position < segments.length; position++) {
    const segment = segments[position]!;
    if (/^\d+$/.test(segment) && list) {
      parts.push(`${say(list.item)} ${Number(segment) + 1}`);
      fields = list.fields;
      list = undefined;
      continue;
    }
    const found: FieldSpec | undefined = fields?.find((entry) => entry.key === segment);
    if (!found) {
      parts.push(position === 2 && COMMON_LABELS[segment] ? say(COMMON_LABELS[segment]) : segment);
      fields = undefined;
      continue;
    }
    const next = segments[position + 1];
    if (found.kind === 'plans' && next !== undefined && /^\d+$/.test(next)) {
      // `plans.2` → "Plans 3".
      parts.push(`${say(found.label)} ${Number(next) + 1}`);
      position++;
      fields = undefined;
      continue;
    }
    // A list is named by its item ("Item 2"), not by the list label as well.
    if (!(found.kind === 'list' && next !== undefined && /^\d+$/.test(next)))
      parts.push(say(found.label));
    fields =
      found.kind === 'image' ? IMAGE_FIELDS : found.kind === 'action' ? ACTION_FIELDS : undefined;
    list = found.kind === 'list' ? found : undefined;
  }
  return parts.join(' › ');
}
